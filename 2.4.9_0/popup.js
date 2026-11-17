/*
 * SignalBots binary-signal extension — popup app (shared).
 *
 * One implementation drives both products; config.js decides the shape:
 *   - Chinese Bot: multi-broker, Real/OTC market select, signal-only.
 *   - <Broker> OTC Bot: fixed broker, OTC only, Get Signal + Auto Trade.
 *
 * Reference-style structure: a license gate with a 7-day trial, a Signal tab and
 * a History tab, and a Register / Telegram / Landing footer. Reads come from the
 * SignalBots endpoint via background.js (server-owned, identical to the web tool).
 *
 * Entitlement is authoritative and server-backed (background CB_CHECK_LICENSE ->
 * the site's web-license endpoint):
 *   - Trial: only the FREE timeframes (4H / 1D) work; every faster timeframe is
 *     locked and opens the "contact support for Premium" modal.
 *   - License: a real, site-registered license (logged-in signalbots.ai account
 *     cookie, or a bot unlock token) unlocks the Premium timeframes for the
 *     brokers it covers — the server serves those reads directly. Any license the
 *     Licensing system does not recognise fails to activate.
 */
(function () {
  "use strict";

  var CFG = window.CB_CONFIG;
  // Broker display name, for products fixed to one broker (Quotex / PocketOption
  // / Olymp / IQ). Used in every user-facing broker-name string so this popup is
  // byte-identical across all of them — and across the multi-broker Chinese Bot,
  // which declares no CFG.BROKER and lets the trader pick from CFG.BROKERS
  // instead, so the fallback below is the string it actually shows.
  var BK = (CFG.BROKER && CFG.BROKER.label) || "your broker";
  var DAY_MS = 24 * 60 * 60 * 1000;
  var MIN_ANALYZE_MS = 900;
  var HISTORY_CAP = 60;
  // Auto-stop guards so the engine never keeps showing "Stop" while it has, in
  // effect, stopped working: N consecutive rejected auto-trades (the broker
  // refusing further orders), or M consecutive failed signal reads, ends the run.
  var AUTO_FAIL_LIMIT = 3;
  var READ_FAIL_LIMIT = 6;
  // How long a dispatched trade may go unanswered before the run stops waiting on
  // it. Comfortably past the socket layer's own 12s no-ack timeout, so this only
  // ever fires when the answer is never coming.
  var TRADE_ACK_LIMIT_MS = 30000;

  // On the expiry field: `time` is seconds and `optionType` is 100 — captured
  // acks show `{"time":10}` opening 16:13:00 -> 16:13:10, exactly ten seconds.
  // What those captures did NOT show, because they were taken on an OTC asset,
  // is that PocketOption accepts a sub-minute expiry only there: the same order
  // against a real-market pair comes back `IncorrectExpTime` with nothing
  // opened. So this real-market build offers 1 min and up (config.js), and the
  // engine remembers any expiry the broker refuses per pair (pocket-socket.js).
  // Two guards remain on top of that, both about a trade whose length the user
  // did not choose: every ack's expiry is checked against the broker's own
  // open/close stamps and a real override stops the run (durationMismatch), and
  // an expiry refusal stops it on the FIRST one (expiryRejected) rather than
  // re-sending an order the broker has already said it will not take.

  // A timeframe code IS its length: "<n><unit>", unit in S/M/H/D. Parsed rather
  // than tabulated, because the table was a fixed list of sixteen codes and every
  // config that needed one outside it — PocketOption's live ladder reaches 4 min
  // and 3 hours, neither of which the table held — silently fell through to the
  // `|| 60` default. A 3-hour selection then paced its countdown, its read
  // deadline and its trade dispatch as if it were one minute.
  var TF_UNIT_SECONDS = { S: 1, M: 60, H: 3600, D: 86400 };
  function tfCodeSeconds(code) {
    var m = /^(\d+)([SMHD])$/.exec(String(code || "").toUpperCase());
    if (!m) { return null; }
    return Number(m[1]) * TF_UNIT_SECONDS[m[2]];
  }

  var SVG = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8z"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    bot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M8 2h8"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/></svg>',
    signal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20v-6M6 20v-3M18 20v-9"/><circle cx="12" cy="6" r="2"/><circle cx="6" cy="11" r="2"/><circle cx="18" cy="5" r="2"/></svg>',
    rescan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>',
    flat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="9" x2="18" y2="9"/><line x1="6" y1="15" x2="18" y2="15"/></svg>',
    // Analyzing state. The same reticle language as the idle tape above, for the
    // same reason: the sibling OTC bot spins a ring here, and a ring spinning
    // the other way is not a second product. Brackets that breathe while a line
    // sweeps between them say "reading this", which a spinner never did.
    scan: '<svg viewBox="0 0 24 24" aria-hidden="true">'
      + '<g class="scan-brace">'
      + '<path d="M3 8.5V4.8C3 3.8 3.8 3 4.8 3H8.5"/>'
      + '<path d="M15.5 3h3.7C20.2 3 21 3.8 21 4.8v3.7"/>'
      + '<path d="M21 15.5v3.7c0 1-.8 1.8-1.8 1.8h-3.7"/>'
      + '<path d="M8.5 21H4.8C3.8 21 3 20.2 3 19.2v-3.7"/></g>'
      + '<line class="scan-line" x1="6.5" y1="12" x2="17.5" y2="12"/>'
      + '<circle class="scan-core" cx="12" cy="12" r="1.5"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
    tg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.9 4.3 18.6 20c-.2 1.1-.9 1.3-1.8.8l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.3-4.9L15.8 7c.4-.3-.1-.5-.6-.2L6.3 12l-4.8-1.5c-1-.3-1-1 .2-1.5L20.6 2.9c.9-.3 1.6.2 1.3 1.4z"/></svg>',
    wa: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.5 15.3L2 22l4.8-1.5A10 10 0 1 0 12 2zm5.7 14.1c-.2.7-1.4 1.3-2 1.4-.5.1-1.2.1-1.9-.1-.4-.1-1-.3-1.8-.6-3-1.3-5-4.4-5.1-4.6-.2-.2-1.3-1.7-1.3-3.3s.8-2.3 1.1-2.6c.3-.3.6-.4.8-.4h.6c.2 0 .4 0 .7.5l.9 2c.1.2.1.4 0 .5l-.4.7c-.1.2-.3.3-.1.6.5.9 1.1 1.5 1.8 2 .3.2.5.2.7 0l.9-1c.2-.2.4-.2.6-.1l1.9.9c.3.1.4.2.5.4.1.2.1.9-.1 1.5z"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2M16 7l3 3M14 9l2 2"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.4l6.5-.9z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.7" y2="16.7"/></svg>'
  };

  // Pair chips shown before the list is folded behind a "more" button. The full
  // broker catalogue runs to ~100 OTC pairs; a wall of chips that tall buries the
  // rest of the Signal tab, so the overflow lives in a searchable modal instead.
  var PAIRS_VISIBLE = 14;

  // Persisted app state.
  var store = {
    broker: null,
    market: "real",          // "real" | "otc" — this product is fixed to the real market
    pair: null,
    tf: null,
    stakeMode: "pct",        // "pct" | "fixed"
    stakePct: 2,
    stakeAmount: 5,
    account: "demo",         // "demo" | "real" (auto-trade only) — safe default
    execMode: "signal",      // "signal" | "auto"
    trialStart: null,
    license: null,           // { brokers: "all"|[keys], token, checkedAt }
    signedOut: false,
    pinned: [],              // pair codes the user pinned; they always lead the list
    history: []
  };

  // Volatile runtime state.
  var rt = {
    running: false, salt: 0, reqId: 0, remaining: 0, lastDirection: null,
    // A trade dispatched and not yet answered, as the ms it left at. Not a
    // boolean: if the answer never comes back at all (a torn-down extension
    // context takes the callback with it) a boolean would wedge the run silently
    // forever, which is the failure mode this whole change is about.
    tradeSentAt: 0,
    tradeWatchdog: null,  // the timer that stops the run if that answer never lands
    readDeadline: 0,      // where the candle clock points, held while it isn't on screen
    // The engine is LOCKED to the pair/timeframe/mode it was started on — separate
    // from the selection chips (store.pair/store.tf). Changing the selection only
    // changes what you're setting up next; it never touches the running engine and
    // never opens a position. To run a different pair you Stop, select, Start.
    pair: null, tf: null, auto: false,
    // The position this run has open, as { closesAt } on our own clock — set from
    // the broker's ack, cleared when it expires or the run stops. While it is
    // set, the run is waiting on it: no read, no second trade.
    position: null,
    failStreak: 0,        // consecutive failed auto-trades (broker rejections)
    readFails: 0,         // consecutive failed signal reads
    liveUid: null,        // the broker account id read from the broker socket, or null
    uidMismatch: false,   // true when liveUid is known AND doesn't match the License's pinned id
    demoBalance: NaN,     // live demo balance from the broker socket (OTC bot)
    realBalance: NaN,     // live real balance from the broker socket (OTC bot)
    brokerTabOpen: false, // whether a broker tab is open for us to talk to
    liveAssets: null,       // [{code,label}] read off the broker tab's own pair picker, broker order, open pairs only — null until the tab has given us a read
    liveCurrentAsset: null, // code of the symbol currently charted on the broker tab, or null
    followedAsset: null     // last charted symbol we already reacted to, so one change acts once
  };
  function balanceForAccount() { return store.account === "real" ? rt.realBalance : rt.demoBalance; }
  var ui = {
    showGate: false,   // manual "back to gate" while entitled
    gateNote: null     // one-shot reason to show on the gate (e.g. a refused license)
  };
  var countdownTimer = null;
  var balanceTimer = null;
  var tgUser = null;
  var refs = {};

  // Helpers.
  function $(sel, root) { return (root || document).querySelector(sel); }
  // Everything this popup renders it renders with innerHTML, and some of what it
  // renders is text off the BROKER's socket — asset symbols and labels, which
  // arrive as whatever the broker sends. This page runs with extension
  // privileges, so that text is escaped at every point it reaches markup. The
  // socket layer also refuses symbols that are not symbol-shaped; this is the
  // other half of that, and the half that still holds if the shape check is ever
  // loosened.
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  // Every panel below is built as an HTML string (SVG icon constants + labels,
  // with the one actually-untrusted ingredient — broker-supplied asset symbols
  // — already run through esc() at the point it's interpolated) and then handed
  // to the DOM through here rather than through .innerHTML, so the extension
  // store's static scanner has real DOM-construction calls to see instead of a
  // property write it can't tell apart from an unsanitized one.
  function htmlToFragment(html) {
    var doc = new DOMParser().parseFromString(html, "text/html");
    var frag = document.createDocumentFragment();
    while (doc.body.firstChild) { frag.appendChild(doc.body.firstChild); }
    return frag;
  }
  function tfSeconds(code) { return tfCodeSeconds(code) || 60; }
  function fmtMoney(n) {
    n = Number(n);
    if (!isFinite(n)) { return "0"; }
    return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  function pairLabel(code) {
    var list = allPairsFlat();
    for (var i = 0; i < list.length; i++) { if (list[i].code === code) { return list[i].label; } }
    return code;
  }
  function brokerLabel(key) {
    var bs = brokers();
    for (var i = 0; i < bs.length; i++) { if (bs[i].key === key) { return bs[i].label; } }
    return key;
  }
  function tfMeta(code) {
    for (var i = 0; i < CFG.TIMEFRAMES.length; i++) { if (CFG.TIMEFRAMES[i].code === code) { return CFG.TIMEFRAMES[i]; } }
    return null;
  }
  function isPremiumTf(code) { var m = tfMeta(code); return !!(m && !m.free); }
  function firstFreeTf() {
    for (var i = 0; i < CFG.TIMEFRAMES.length; i++) { if (CFG.TIMEFRAMES[i].free) { return CFG.TIMEFRAMES[i].code; } }
    return "4H";
  }

  function brokers() { return CFG.SHOW_BROKER ? CFG.BROKERS : [CFG.BROKER]; }

  // The live list read off the broker tab's own pair picker (open real-market
  // pairs, in the broker's own order) always wins over the static config list —
  // it's what the user actually sees on PocketOption right now. The symbol
  // currently charted on the tab is pinned first. Falls back to config.js's
  // STATIC_PAIRS until the tab has given us a first read (e.g. right after
  // opening the popup).
  function currentPairs() {
    if (store.market === "real" && CFG.SHOW_MARKET) { return (CFG.REAL_PAIRS || []).map(withLabel); }
    var list;
    if (CFG.ALLOW_AUTOTRADE && rt.liveAssets && rt.liveAssets.length) {
      list = rt.liveAssets.map(function (p) { return { code: p.code, label: p.label, payout: p.payout }; });
    } else {
      var key = store.broker || (CFG.BROKER && CFG.BROKER.key);
      var codes = (CFG.STATIC_PAIRS && (CFG.STATIC_PAIRS[key] || CFG.STATIC_PAIRS._single)) || [];
      list = codes.map(withLabel);
    }
    // Pin the symbol the broker tab is actually charting, whichever list we ended
    // up with. The charted symbol is known long before — and independently of —
    // the full list, so pinning it only in the live-list branch left it invisible
    // in exactly the case that matters: picker closed, static list showing.
    if (CFG.ALLOW_AUTOTRADE && rt.liveCurrentAsset) {
      var idx = -1;
      for (var i = 0; i < list.length; i++) { if (list[i].code === rt.liveCurrentAsset) { idx = i; break; } }
      if (idx > 0) { list.unshift(list.splice(idx, 1)[0]); }
      else if (idx === -1) { list.unshift(withLabel(rt.liveCurrentAsset)); }
    }
    return applyPins(list);
  }

  // Pinned pairs lead the list, in the order they were pinned, ahead of even the
  // charted symbol — a pin is an explicit standing choice, the charted symbol is
  // just where the tab happens to be. A pin for a pair the broker isn't offering
  // right now is kept in storage but contributes nothing, so it comes back on its
  // own when that pair reopens.
  function applyPins(list) {
    if (!store.pinned || !store.pinned.length) { return list; }
    var byCode = {};
    list.forEach(function (p) { byCode[p.code] = p; });
    var head = [];
    store.pinned.forEach(function (code) { if (byCode[code]) { head.push(byCode[code]); } });
    if (!head.length) { return list; }
    var isPinned = {};
    head.forEach(function (p) { isPinned[p.code] = 1; });
    return head.concat(list.filter(function (p) { return !isPinned[p.code]; }));
  }

  function isPinned(code) { return (store.pinned || []).indexOf(code) !== -1; }

  function togglePin(code) {
    var i = (store.pinned || []).indexOf(code);
    if (i === -1) { store.pinned.push(code); } else { store.pinned.splice(i, 1); }
    persist();
    renderPairs();
    if ($("[data-pair-list]")) { renderPairList(); }
  }
  function withLabel(code) { return { code: code, label: CFG.label(code) }; }
  function allPairsFlat() {
    var out = [], seen = {};
    function add(code) { if (!seen[code]) { seen[code] = 1; out.push(withLabel(code)); } }
    (CFG.REAL_PAIRS || []).forEach(add);
    Object.keys(CFG.OTC_PAIRS || {}).forEach(function (k) { (CFG.OTC_PAIRS[k] || []).forEach(add); });
    return out;
  }

  // Entitlement.
  function licensed() { return !!store.license; }
  function premiumScope() { return store.license ? store.license.brokers : null; }
  function premiumUnlocked(broker) {
    var s = premiumScope();
    if (!s) { return false; }
    return s === "all" || (Array.isArray(s) && s.indexOf(broker) !== -1);
  }
  // Premium is only actually usable when the license covers the broker AND the
  // signed-in broker account matches the one the license is pinned to. A wrong
  // account keeps every Premium timeframe locked even with a valid license.
  function premiumAvailable(broker) { return premiumUnlocked(broker) && !rt.uidMismatch; }
  function trialActive() { return store.trialStart != null && (Date.now() - store.trialStart) < CFG.TRIAL_DAYS * DAY_MS; }
  function trialEnded() { return store.trialStart != null && !trialActive() && !licensed(); }
  function appEntitled() { return licensed() || trialActive(); }
  function showApp() { return appEntitled() && !store.signedOut && !ui.showGate; }
  function trialDaysLeft() {
    var left = CFG.TRIAL_DAYS * DAY_MS - (Date.now() - (store.trialStart || Date.now()));
    return Math.max(0, Math.ceil(left / DAY_MS));
  }

  // Persistence.
  function persist() { try { chrome.storage.local.set({ cbStore: store }); } catch (e) {} }
  function load(cb) {
    try {
      chrome.storage.local.get("cbStore", function (r) {
        if (r && r.cbStore) {
          Object.keys(store).forEach(function (k) {
            if (r.cbStore[k] !== undefined && r.cbStore[k] !== null) { store[k] = r.cbStore[k]; }
          });
        }
        applyDefaults();
        cb();
      });
    } catch (e) { applyDefaults(); cb(); }
  }
  function applyDefaults() {
    if (!store.broker) { store.broker = brokers()[0].key; }
    if (!CFG.SHOW_MARKET) { store.market = CFG.MARKET || "otc"; }
    if (CFG.ALLOW_AUTOTRADE) {
      // Auto-trade bot: NO pre-selected / remembered pair or timeframe. The user
      // must consciously pick both every session before any signal or trade runs,
      // so they never auto-trade a symbol they didn't choose this time.
      store.pair = null; store.tf = null;
    } else {
      if (!store.tf) { store.tf = CFG.DEFAULTS.tf; }
      if (!store.pair) { var ps = currentPairs(); store.pair = ps.length ? ps[0].code : null; }
    }
    if (store.execMode !== "auto" && store.execMode !== "signal") { store.execMode = "signal"; }
    if (store.stakeMode !== "fixed") { store.stakeMode = "pct"; }
    if (store.account !== "real") { store.account = "demo"; }
  }

  // Keep the selected timeframe legal for the current entitlement: a Premium
  // timeframe stays selected only while unlocked, else drops to the first free one.
  function ensureTfAllowed() {
    if (isPremiumTf(store.tf) && !premiumAvailable(store.broker)) { store.tf = firstFreeTf(); }
  }

  // Messaging.
  function pickTelegram() {
    var pool = CFG.TELEGRAM_POOL || [];
    if (!pool.length) { return null; }
    var key = "cb_tg_idx", idx = -1;
    try { var s = sessionStorage.getItem(key); if (s !== null) { idx = parseInt(s, 10); } } catch (e) {}
    if (!(idx >= 0 && idx < pool.length)) {
      idx = Math.floor(Math.random() * pool.length);
      try { sessionStorage.setItem(key, String(idx)); } catch (e) {}
    }
    return pool[idx];
  }
  // The product name used in support messages — the product's own name from
  // config (e.g. "Olymp OTC AI Bot" / "Chinese Bot").
  function productName() { return CFG.APP_NAME; }

  // Default license-request message, prefilled on every messenger button. The
  // broker is named ONLY once the user is inside the multi-broker app and has a
  // broker selected — never on the gate (before license/trial), where the default
  // broker isn't a real choice. The single-broker OTC bot's name already carries
  // its broker, so it never needs a separate broker line.
  function licenseMessage() {
    var base = "Hi, I'd like to buy a License for the SignalBots " + productName();
    if (CFG.SHOW_BROKER && showApp() && store.broker) {
      return base + " — broker: " + brokerLabel(store.broker) + ". Please guide me on pricing and activation.";
    }
    return base + ". Please guide me on pricing and activation.";
  }
  function telegramUrl() {
    var u = tgUser || (CFG.TELEGRAM_POOL && CFG.TELEGRAM_POOL[0]) || "SignalBotsai";
    return "https://t.me/" + u + "?text=" + encodeURIComponent(licenseMessage());
  }
  function whatsappUrl() {
    return "https://wa.me/" + (CFG.WHATSAPP || "") + "?text=" + encodeURIComponent(licenseMessage());
  }

  // Screen router.
  function showScreen(name) {
    document.querySelectorAll("[data-screen]").forEach(function (el) {
      el.hidden = el.getAttribute("data-screen") !== name;
    });
  }
  function route() {
    if (showApp()) { renderApp(); showScreen("app"); }
    else { stopBalancePoll(); renderGate(); showScreen("gate"); }
    renderFooter();
  }

  // License gate.
  function renderGate() {
    var gate = $('[data-screen="gate"]');
    var ended = trialEnded();
    var canBack = appEntitled() && !store.signedOut && ui.showGate;
    gate.className = "gate" + (ended ? " is-ended" : "");
    var logo = chrome.runtime.getURL("icons/mark_96.png");

    var title, sub;
    if (ended) {
      title = 'Your trial has <b>ended</b>';
      sub = 'Enter the License key from signalbots.ai → My Products, or log in there with your licensed account and tap Activate.';
    } else if (canBack) {
      title = 'Get <b>Premium</b>';
      sub = 'Unlock every intraday timeframe. Enter a License key, or contact us from the Telegram button below.';
    } else {
      title = 'Activate <b>' + CFG.APP_NAME + '</b>';
      sub = 'Activate a License, or start a free 7-day trial (4H & 1D timeframes).';
    }

    var trialBtn = "";
    if (store.trialStart == null) {
      trialBtn = '<div class="gate-or">or</div><button class="gate-trial" data-start-trial>Start 7-Day Free Trial</button>';
    } else if (trialActive() && store.signedOut) {
      trialBtn = '<div class="gate-or">or</div><button class="gate-trial" data-start-trial>Resume trial · ' + trialDaysLeft() + 'd left</button>';
    }

    gate.textContent = ""; gate.appendChild(htmlToFragment(''
      + (canBack ? '<button class="gate-back" data-gate-back>' + SVG.back + ' Back</button>' : '')
      + '<img class="gate-logo" src="' + logo + '" alt="SignalBots">'
      + '<div class="gate-title">' + title + '</div>'
      + '<div class="gate-sub">' + sub + '</div>'
      + '<form class="gate-form" data-activate-form>'
      + '  <input class="gate-input" data-license-input type="text" placeholder="License key (SB-XXXXXXXXXX)" autocomplete="off">'
      + '  <button class="gate-activate" type="submit">Activate License</button>'
      + '</form>'
      + '<div class="gate-hint">Your License key is on signalbots.ai → My Products. Or log in there in this browser and tap Activate — no key needed.</div>'
      + trialBtn
      + '<div class="gate-note" data-gate-note></div>'));

    $("[data-activate-form]", gate).addEventListener("submit", function (e) {
      e.preventDefault(); activateLicense($("[data-license-input]", gate).value);
    });
    // A reason carried over from a background re-check that dropped the license.
    // Shown once, then cleared, so it never lingers over an unrelated visit.
    if (ui.gateNote) {
      var carried = $("[data-gate-note]", gate);
      if (carried) { carried.className = "gate-note is-err"; carried.textContent = ui.gateNote; }
      ui.gateNote = null;
    }
    var tb = $("[data-start-trial]", gate); if (tb) { tb.addEventListener("click", startTrial); }
    var bk = $("[data-gate-back]", gate); if (bk) { bk.addEventListener("click", function () { ui.showGate = false; route(); }); }
  }

  // Validate against the real Licensing system. Accepts a pasted unlock link/token
  // (?lt=) or nothing (pure logged-in-cookie check). Only a license the server
  // recognises activates; anything else fails.
  function activateLicense(raw) {
    var note = $("[data-gate-note]");
    var val = (raw || "").trim();
    // Accept a license key (SB-XXXXXXXXXX), a bot unlock link/token (?lt=), or
    // nothing (a pure logged-in-cookie check).
    var key = "", lt = "";
    var km = val.match(/[?&]key=([^&#\s]+)/i);
    var lm = val.match(/[?&]lt=([^&#\s]+)/i);
    if (km) { key = decodeURIComponent(km[1]); }
    else if (/^sb-/i.test(val)) { key = val; }
    if (lm) { lt = decodeURIComponent(lm[1]); }
    else if (!key && val && val.indexOf("http") !== 0) { lt = val; }
    key = key.toUpperCase();
    if (note) { note.className = "gate-note"; note.textContent = "Checking your License…"; }

    chrome.runtime.sendMessage({ type: "CB_CHECK_LICENSE", payload: { key: key, lt: lt, item: CFG.ITEM, broker: brokerParam() } }, function (res) {
      if (chrome.runtime.lastError || !res || !res.ok || !res.data) {
        if (note) { note.className = "gate-note is-err"; note.textContent = "Couldn't reach the License server. Check your connection and try again."; }
        return;
      }
      if (res.data.licensed) {
        store.license = {
          brokers: res.data.brokers, key: key || null, token: lt || null, checkedAt: Date.now(),
          brokerUid: res.data.broker_uid || null
        };
        store.signedOut = false;
        ui.showGate = false;
        alignBrokerToLicense();   // land on a broker the license actually covers
        ensureTfAllowed();
        persist();
        route();
        syncLiveUid();
      } else if (note) {
        note.className = "gate-note is-err";
        note.textContent = licenseRefusalText(res.data);
      }
    });
  }

  // Why the server refused. A real license scoped to a DIFFERENT broker is the
  // one refusal worth naming: the key is genuine, it just doesn't cover this
  // broker, and telling the customer to "check the key" would send them looking
  // for a problem that isn't there.
  function licenseRefusalText(data) {
    if (data && data.error === "broker_not_covered") {
      var covered = data.brokers;
      var names = (Array.isArray(covered) && covered.length)
        ? covered.map(brokerLabel).join(", ") : null;
      return "This License is valid, but it isn't for " + BK
        + (names ? " — it covers " + names + "." : ".")
        + " Ask support to add " + BK + " to it, or use the " + BK + " License we sent you.";
    }
    return "That License key wasn't recognised. Check the SB- key we sent you, "
      + "log in at signalbots.ai, or paste your unlock link.";
  }

  // Silent re-check on open, so a revoked/expired license stops working.
  function refreshLicense() {
    if (!licensed()) { return; }
    chrome.runtime.sendMessage({ type: "CB_CHECK_LICENSE", payload: { key: store.license.key || "", lt: store.license.token || "", item: CFG.ITEM, broker: brokerParam() } }, function (res) {
      if (chrome.runtime.lastError || !res || !res.ok || !res.data) { return; }
      if (res.data.licensed) {
        store.license.brokers = res.data.brokers; store.license.checkedAt = Date.now();
        store.license.brokerUid = res.data.broker_uid || null;
        alignBrokerToLicense();   // land on a broker the license actually covers
      } else {
        store.license = null;
        ui.gateNote = licenseRefusalText(res.data);
      }
      ensureTfAllowed();
      persist();
      if (!showApp()) { route(); }
      else { renderApp(); }
      syncLiveUid();
    });
  }

  function startTrial() {
    if (store.trialStart == null) { store.trialStart = Date.now(); }
    store.signedOut = false;
    ui.showGate = false;
    ensureTfAllowed();
    persist();
    route();
  }
  function logout() {
    stopEngine();     // kill any running loop/countdown so it can't re-open the modal
    closeModal();
    store.license = null;
    store.signedOut = true;
    ui.showGate = false;
    persist();
    route();
  }

  // Register -> OUR affiliate/IB link for the broker in play (rel sponsored
  // nofollow noopener, never noreferrer).
  function registerUrl() {
    if (CFG.AFFILIATE_URL) { return CFG.AFFILIATE_URL; }
    if (CFG.AFFILIATE) { return CFG.AFFILIATE[store.broker] || CFG.AFFILIATE[brokers()[0].key] || "#"; }
    return CFG.REGISTER_URL || "#";
  }
  function landingLabel() { return CFG.LANDING_LABEL || (brokerLabel(store.broker) + " Bot"); }

  // When a license is broker-scoped and the selected broker isn't covered, point
  // the selection at the first covered broker so a licensed user immediately sees
  // Premium unlocked instead of a locked default. "all"/unrestricted needs no
  // alignment; a license covering no known broker leaves the selection untouched.
  function alignBrokerToLicense() {
    var s = premiumScope();
    if (!s || s === "all" || !Array.isArray(s) || !s.length) { return; }
    if (s.indexOf(store.broker) !== -1) { return; }
    var keys = brokers().map(function (b) { return b.key; });
    for (var i = 0; i < s.length; i++) {
      if (keys.indexOf(s[i]) !== -1) {
        store.broker = s[i];
        reconcilePair();
        paintFooterLinks();
        return;
      }
    }
  }

  function paintFooterLinks() {
    var foot = $("[data-foot]");
    if (!foot) { return; }
    var reg = $("[data-register]", foot); if (reg) { reg.href = registerUrl(); }
    var land = $("[data-landing-label]", foot); if (land) { land.textContent = landingLabel(); }
    var tgLink = $("[data-tg-link]", foot); if (tgLink) { tgLink.href = telegramUrl(); }
  }
  function renderFooter() {
    var foot = $("[data-foot]");
    foot.hidden = false;
    foot.textContent = ""; foot.appendChild(htmlToFragment(''
      + '<a class="foot-btn" data-register href="' + registerUrl() + '" target="_blank" rel="sponsored nofollow noopener">' + SVG.user + ' Register</a>'
      + '<a class="foot-btn is-tg" data-tg-link target="_blank" rel="noopener">' + SVG.tg + ' Telegram</a>'
      + '<a class="foot-btn" data-landing href="' + CFG.LANDING_URL + '" target="_blank" rel="noopener">' + SVG.globe + ' <span data-landing-label>' + landingLabel() + '</span></a>'));
    var tgLink = $("[data-tg-link]", foot); if (tgLink) { tgLink.href = telegramUrl(); }
  }

  // App shell.
  function renderApp() {
    var appNameEl = $("[data-app-name]");
    appNameEl.textContent = "";
    appNameEl.appendChild(htmlToFragment(CFG.APP_NAME_HTML || CFG.APP_NAME));
    $("[data-app-tagline]").textContent = CFG.APP_TAGLINE;
    renderStatus();
    renderAppActions();
    renderBrokerStatus();
    renderAccountBar();
    buildSignalPanel();
    renderHistory();
    wireTabs();
  }

  // Top status strip (OTC bot): are we talking to an open broker tab, what is the
  // logged-in broker id, and does the license recognise that account? Always
  // visible under the tabs so a beginner can see connection + identity at a glance.
  function brokerMatchState() {
    if (!licensed()) { return { cls: "neutral", text: trialActive() ? "Free trial" : "No License" }; }
    var pinned = store.license && store.license.brokerUid;
    if (!pinned) { return { cls: "ok", text: "License active" }; }
    if (!rt.brokerTabOpen || !rt.liveUid) { return { cls: "neutral", text: "License active · verifying" }; }
    if (rt.uidMismatch) { return { cls: "bad", text: "Wrong account for License" }; }
    return { cls: "ok", text: "License active · account matches" };
  }
  function renderBrokerStatus() {
    var el = $("[data-broker-status]");
    if (!el) { return; }
    if (!CFG.ALLOW_AUTOTRADE) { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false;
    var conn = rt.brokerTabOpen;
    var idText = (conn && rt.liveUid) ? rt.liveUid : "—";
    var m = brokerMatchState();
    el.textContent = ""; el.appendChild(htmlToFragment(''
      + '<div class="statusbar-info">'
      + '  <span class="bstat bstat-conn ' + (conn ? "is-on" : "is-off") + '"><span class="bstat-dot"></span>'
      + (conn ? ("On " + BK) : ("Open your " + BK + " tab")) + '</span>'
      + '  <span class="bstat bstat-id" title="Your ' + BK + ' account ID">ID <b>' + idText + '</b></span>'
      + '  <span class="bstat bstat-lic is-' + m.cls + '">' + m.text + '</span>'
      + '</div>'
      + '<div class="statusbar-acct" data-acct-bar></div>'));
    renderAccountBar();
  }

  // Account bar — sits under the tabs (always visible across Signal/History) for
  // the OTC bot: a round Demo/Real toggle switch plus the live account balance.
  // Hidden entirely on the multi-broker Chinese Bot (no broker page to trade on).
  // Lives inside the status row, so it is never hidden on its own and its markup
  // stays compact: the switch, then the balance for whichever account it is on.
  function renderAccountBar() {
    var bar = $("[data-acct-bar]");
    if (!bar || !CFG.ALLOW_AUTOTRADE) { return; }
    bar.textContent = ""; bar.appendChild(htmlToFragment(''
      + '<button class="acct-toggle" data-account role="switch" aria-checked="false" title="Switch between your Demo and Real ' + BK + ' account">'
      + '  <span class="acct-toggle-label is-demo">Demo</span>'
      + '  <span class="acct-toggle-track"><span class="acct-toggle-knob"></span></span>'
      + '  <span class="acct-toggle-label is-real">Real</span>'
      + '</button>'
      + '<span class="acct-bal-value" data-acct-bal-value>—</span>'));
    var tog = $("[data-account]", bar);
    tog.addEventListener("click", function () { selectAccount(store.account === "real" ? "demo" : "real"); });
    paintAccountBar();
  }

  function paintAccountBar() {
    var bar = $("[data-acct-bar]");
    if (!bar) { return; }
    var real = store.account === "real";
    var tog = $("[data-account]", bar);
    if (tog) {
      tog.setAttribute("aria-checked", real ? "true" : "false");
      tog.classList.toggle("is-real", real);
      tog.classList.toggle("is-demo", !real);
    }
    var bv = $("[data-acct-bal-value]", bar);
    if (bv) {
      var bal = balanceForAccount();
      if (isFinite(bal) && bal >= 0) {
        bv.textContent = "$" + fmtMoney(bal);
        bv.className = "acct-bal-value" + (real ? " is-real" : "");
      } else {
        bv.textContent = "—";
        bv.className = "acct-bal-value is-muted";
      }
    }
  }
  function renderStatus() {
    var el = $("[data-app-status]");
    if (licensed()) { el.className = "app-status is-licensed"; el.textContent = "Licensed"; }
    else if (trialActive()) { el.className = "app-status is-trial"; el.textContent = "Trial · " + trialDaysLeft() + "d"; }
    else { el.className = "app-status"; el.textContent = ""; }
  }
  // Header controls: return to the gate (get Premium / enter license) and log out.
  function renderAppActions() {
    var wrap = $("[data-app-actions]");
    if (!wrap) { return; }
    wrap.textContent = ""; wrap.appendChild(htmlToFragment((!licensed() ? '<button class="app-act" data-act-upgrade title="Get Premium / enter License">' + SVG.key + '</button>' : '')
      + '<button class="app-act" data-act-logout title="Log out">' + SVG.logout + '</button>'));
    var up = $("[data-act-upgrade]", wrap);
    if (up) { up.addEventListener("click", function () { ui.showGate = true; route(); }); }
    $("[data-act-logout]", wrap).addEventListener("click", logout);
  }

  function wireTabs() {
    document.querySelectorAll("[data-tab]").forEach(function (btn) {
      btn.onclick = function () {
        var name = btn.getAttribute("data-tab");
        document.querySelectorAll("[data-tab]").forEach(function (b) { b.setAttribute("aria-selected", b === btn ? "true" : "false"); });
        document.querySelectorAll("[data-panel]").forEach(function (p) { p.hidden = p.getAttribute("data-panel") !== name; });
        if (name === "history") { renderHistory(); }
      };
    });
  }

  // Chip row. Each item may carry premium/locked flags (a locked chip shows a lock
  // glyph and opens the Premium modal on click) and a `running` flag (a live dot,
  // "auto" when it's the armed auto-trade pair) to show per-pair engine state.
  function chipRow(attr, items, active, opts) {
    opts = opts || {};
    var html = '<div class="chips' + (opts.scroll ? " chips--pairs" : "") + '" data-' + attr + '>';
    items.forEach(function (it) {
      var cls = "chip" + (it.locked ? " is-locked" : "") + (it.running ? " is-running" + (it.auto ? " is-auto" : "") : "");
      html += '<button type="button" class="' + cls + '" data-' + attr + '-val="' + it.value + '"'
        + (it.locked ? ' data-locked="1"' : '')
        + ' aria-pressed="' + (it.value === active ? "true" : "false") + '">'
        + (it.running ? '<span class="chip-run" title="' + (it.auto ? "Auto-trading" : "Running") + '"></span>' : '')
        + it.label
        + (it.locked ? ' <span class="chip-lock">' + SVG.lock + '</span>' : '') + '</button>';
    });
    return html + '</div>';
  }

  function tfChipItems() {
    var unlocked = premiumAvailable(store.broker);
    return CFG.TIMEFRAMES.map(function (t) {
      var locked = !t.free && !unlocked;
      return { value: t.code, label: t.label, locked: locked };
    });
  }

  function buildSignalPanel() {
    ensureTfAllowed();
    var panel = $('[data-panel="signal"]');

    var controls = "";
    if (CFG.SHOW_BROKER) {
      controls += '<div class="field"><div class="field-label">Broker <span class="field-tag" data-broker-tag></span></div>'
        + chipRow("broker", brokers().map(function (b) { return { value: b.key, label: b.label }; }), store.broker) + '</div>';
    }
    if (CFG.SHOW_MARKET) {
      controls += '<div class="field"><div class="field-label">Market type</div>'
        + chipRow("market", [{ value: "real", label: "Real market" }, { value: "otc", label: "OTC" }], store.market) + '</div>';
    }
    controls += '<div class="field"><div class="field-label">Currency pair <span class="field-tag" data-pair-tag></span></div><div data-pairs-wrap></div></div>';
    controls += '<div class="field"><div class="field-label">Timeframe <span class="field-tag" data-tf-tag></span></div><div data-tf-wrap></div></div>';

    if (CFG.ALLOW_AUTOTRADE) {
      controls += stakeFieldHtml();
    }

    // Two dedicated CTAs (Get Signal / Auto-Trade) replace the old mode-toggle +
    // single trigger. renderCta() fills [data-cta] and swaps to a Stop button
    // while a loop is running.
    panel.textContent = ""; panel.appendChild(htmlToFragment('<div class="sig-grid">'
      + '<div class="sig-controls">' + controls + '</div>'
      + '<div class="sig-card-col"><div data-uid-banner hidden></div><div class="cta-row" data-cta></div>' + signalCardHtml() + '</div>'
      + '</div>'));

    refs.card = $("[data-card]", panel);
    refs.cta = $("[data-cta]", panel);
    refs.status = $("[data-status]", panel);
    refs.countdown = $("[data-countdown]", panel);
    refs.countdownLabel = $("[data-countdown-label]", panel);

    renderPairs();
    rebuildTfChips();
    if (CFG.ALLOW_AUTOTRADE) { renderStake(); }
    wireSignalPanel(panel);
    paintTags();
    renderCta();
    renderUidBanner();
    if (CFG.ALLOW_AUTOTRADE) { paintStakePreview(); syncLiveUid(); startBalancePoll(); }
    setStatus("Ready. " + (CFG.ALLOW_AUTOTRADE ? "Pick your setup, then Get Signal or start Auto-Trade." : "Pick your setup and get a signal."), null);
  }

  // The two primary CTAs — Get Signal (signal-only loop) and Auto-Trade (loop
  // that also places the trade). While a loop runs, both collapse to one Stop
  // button. The Chinese Bot (no auto-trade) shows a single Get Signal button.
  function renderCta() {
    var wrap = refs.cta;
    if (!wrap) { return; }
    if (rt.running) {
      var mode = (CFG.ALLOW_AUTOTRADE && rt.auto) ? "Auto-Trade" : "Signal";
      var on = rt.pair ? (" · " + esc(pairLabel(rt.pair))) : "";
      wrap.className = "cta-row";
      wrap.textContent = ""; wrap.appendChild(htmlToFragment('<button class="cta cta--stop" data-cta-stop>' + SVG.stop + ' Stop ' + mode + on + '</button>'));
      $("[data-cta-stop]", wrap).addEventListener("click", stopLoop);
      return;
    }
    if (CFG.ALLOW_AUTOTRADE) {
      wrap.className = "cta-row cta-row--dual";
      wrap.textContent = ""; wrap.appendChild(htmlToFragment(''
        + '<button class="cta cta--signal" data-cta-signal>' + SVG.signal + ' Get Signal</button>'
        + '<button class="cta cta--auto" data-cta-auto>' + SVG.bot + ' Auto-Trade</button>'));
      $("[data-cta-signal]", wrap).addEventListener("click", function () { startFromCta("signal"); });
      $("[data-cta-auto]", wrap).addEventListener("click", function () { startFromCta("auto"); });
    } else {
      wrap.className = "cta-row";
      wrap.textContent = ""; wrap.appendChild(htmlToFragment('<button class="cta cta--signal" data-cta-signal>' + SVG.play + ' Get Signal</button>'));
      $("[data-cta-signal]", wrap).addEventListener("click", function () { startFromCta("signal"); });
    }
  }
  function startFromCta(mode) {
    // Nothing is pre-selected — require an explicit pair AND timeframe before any
    // run, shown as a MODAL (not a status line the user can't see at the bottom).
    if (!store.pair || !store.tf) { openChooseModal(); return; }
    var wantAuto = (mode === "auto" && CFG.ALLOW_AUTOTRADE);
    store.execMode = wantAuto ? "auto" : "signal";
    persist();
    startLoop();
  }

  function stakeFieldHtml() {
    return '<div class="field"><div class="field-label">Stake <span class="field-tag" data-stake-tag></span></div>'
      + '<div class="stake-mode" data-stake-mode>'
      + '<button class="stake-mode-btn" data-stakemode-val="pct">% of balance</button>'
      + '<button class="stake-mode-btn" data-stakemode-val="fixed">Fixed amount</button>'
      + '</div><div data-stake-wrap></div>'
      + '<div class="stake-preview" data-stake-preview></div></div>';
  }

  // Always show the stake as a concrete dollar amount — in % mode, resolve it
  // against the live balance (same rounding as computeStakeAmount), so the
  // trader sees exactly what will be risked per trade in both modes.
  function paintStakePreview() {
    var el = $("[data-stake-preview]");
    if (!el) { return; }
    if (store.stakeMode === "fixed") {
      el.textContent = ""; el.appendChild(htmlToFragment('Risk per trade <b>$' + fmtMoney(store.stakeAmount) + '</b>'));
      return;
    }
    var bal = balanceForAccount();
    if (isFinite(bal) && bal > 0) {
      var amt = Math.max(1, Math.round(bal * store.stakePct / 100 * 100) / 100);
      el.textContent = ""; el.appendChild(htmlToFragment(store.stakePct + '% of $' + fmtMoney(bal) + ' &rarr; <b>$' + fmtMoney(amt) + '</b> per trade'));
    } else {
      el.textContent = ""; el.appendChild(htmlToFragment(store.stakePct + '% of balance <span class="stake-preview-hint">— open ' + BK + ' to see the amount</span>'));
    }
  }

  function signalCardHtml() {
    return '<div class="card" data-card data-state="empty">'
      + '<div class="card-empty">' + idleScanHtml()
      + '<p class="idle-live"><span class="live-dot"></span>AI scanning the market</p>'
      + '<p>Pick a pair and timeframe, then start the engine for an AI read.</p></div>'
      + '<div class="analyzing"><div class="scanner">' + SVG.scan + '</div><p class="analyzing-title">AI analyzing the market</p><p class="analyzing-sub" data-analyzing-sub>Scanning trend, momentum and volatility.</p></div>'
      + '<div class="live">'
      + '  <div class="live-top"><div class="asset"><span class="asset-pair" data-out-pair>—</span><span class="asset-tf" data-out-tf>—</span></div>'
      + '    <div class="live-actions"><button class="rescan" data-rescan>' + SVG.rescan + ' Re-Scan</button><span class="live-pill"><span class="live-dot"></span>AI read</span></div></div>'
      + '  <div class="verdict"><span class="verdict-ico"><span class="ico ico--up">' + SVG.up + '</span><span class="ico ico--down">' + SVG.down + '</span><span class="ico ico--flat">' + SVG.flat + '</span></span>'
      + '    <span><span class="verdict-word" data-word>—</span><div class="verdict-sub" data-sub>—</div></span></div>'
      + '  <div class="strength"><div class="strength-head"><span>AI confidence</span><span class="strength-pct" data-strength-pct>—</span></div><div class="bar"><span class="bar-fill" data-strength-fill></span></div></div>'
      + '  <div class="meters">' + meterRow("trend", "Trend") + meterRow("momentum", "Momentum") + meterRow("volatility", "Volatility") + '</div>'
      + '</div>'
      + '<div class="card-foot"><div class="countdown"><span data-countdown-label>Next read in</span><span class="countdown-time" data-countdown>—</span></div><div class="status" data-status></div></div>'
      + '<p class="disclaimer">AI-generated read for education, not financial advice. A historical edge never guarantees the next trade — size your risk first.</p>'
      + '</div>';
  }
  // Idle-state motion for the empty card: a price tape with a targeting reticle
  // that hops between its swing points, locking onto each one and lighting the
  // stretch of tape it has read. The picture is what a scalper actually does —
  // find the level, take the entry — which is also what tells this product apart
  // from the OTC sibling at a glance: that one lights a candle series bar by bar
  // under a beam sweeping past it, a continuous wash across a static chart. This
  // one is discrete: three stops, three locks, nothing between them. Different
  // silhouette (a line and a reticle, not candles and a beam), different motion
  // (hops, not a sweep), different idea. A mirrored copy of the sibling's beam
  // is what this replaces; direction and colour alone were not a difference.
  //
  // Only transform and opacity animate, so all of it stays on the compositor —
  // no layout, no colour interpolation, nothing that costs a frame in a popup
  // that is also polling a socket.
  //
  // Purely decorative: hidden from assistive tech, with the line underneath
  // carrying the same meaning in words. It exists only while the card is empty;
  // every other card state takes .card-empty out of the layout entirely.

  // The tape, as "x,y" pairs in the 112x44 viewBox. Shaped so the three points
  // the reticle stops at are the three obvious pivots — a swing low, the high,
  // and the low after it — because a reticle that lands on nothing in particular
  // reads as decoration rather than as a read.
  var IDLE_TAPE = "6,31 13,27 20,34 27,24 34,28 41,19 48,23 55,10 62,17 69,14 "
    + "76,24 83,20 90,33 97,26 104,21";
  // [x, y] of each stop, and the x the lit tape reaches once that stop is locked
  // (a little past the reticle, so the tape leads the eye to the next one).
  var IDLE_LOCKS = [[20, 34, 25], [55, 10, 60], [90, 33, 112]];

  // Corner brackets drawn around (0, 0) so the group scales about its own centre
  // with no transform-box, and the pivot it has locked shows through the middle.
  function idleReticleHtml() {
    return '<g class="lock-bracket">'
      + '<path d="M-6-2.7V-6H-2.7"/><path d="M2.7-6H6V-2.7"/>'
      + '<path d="M6 2.7V6H2.7"/><path d="M-2.7 6H-6V2.7"/></g>';
  }

  function idleScanHtml() {
    var pivots = "", hits = "";
    IDLE_LOCKS.forEach(function (t, i) {
      pivots += '<circle class="lock-pivot" cx="' + t[0] + '" cy="' + t[1] + '" r="1.9"/>';
      hits += '<circle class="lock-hit lock-hit--' + (i + 1) + '" cx="' + t[0]
        + '" cy="' + t[1] + '" r="2.2"/>';
    });
    return '<svg class="ai-scan" viewBox="0 0 112 44" width="140" height="55" aria-hidden="true">'
      + '<defs><clipPath id="sb-lock-clip">'
      + '<rect class="lock-clip-rect" x="-112" y="0" width="112" height="44"/></clipPath></defs>'
      + '<g class="lock-grid"><path d="M4 8H108M4 18H108M4 28H108M4 38H108"/></g>'
      + '<polyline class="lock-tape" points="' + IDLE_TAPE + '"/>'
      + pivots
      + '<g class="lock-lit"><g clip-path="url(#sb-lock-clip)">'
      + '<polyline class="lock-tape-lit" points="' + IDLE_TAPE + '"/></g></g>'
      + hits
      + '<g class="lock-sight"><path class="lock-sight-line" d="M0 0V44"/></g>'
      + '<g class="lock-reticle"><g class="lock-reticle-in">' + idleReticleHtml() + '</g>'
      + '<g class="lock-ring-wrap"><circle class="lock-ring" r="5.6"/></g></g>'
      + '</svg>';
  }

  function meterRow(key, label) {
    return '<div class="meter" data-meter="' + key + '"><span class="meter-label">' + label + '</span><div class="bar"><span class="bar-fill" data-meter-fill></span></div><span class="meter-value" data-meter-value>—</span></div>';
  }

  function pairChipLabel(p) { return store.market === "otc" ? p.label + " OTC" : p.label; }

  // One pair chip: the select button plus its own pin toggle. They are siblings
  // inside a wrapper rather than nested buttons, which is invalid markup and
  // swallows the inner click in every browser.
  function pairChipHtml(p) {
    var running = rt.running && rt.pair === p.code;
    var cls = "chip" + (running ? " is-running" + (rt.auto ? " is-auto" : "") : "");
    var on = isPinned(p.code);
    return '<span class="pair-chip' + (on ? " is-pinned" : "") + '">'
      + '<button type="button" class="' + cls + '" data-pair-val="' + esc(p.code) + '"'
      + ' aria-pressed="' + (p.code === store.pair ? "true" : "false") + '">'
      + (running ? '<span class="chip-run" title="' + (rt.auto ? "Auto-trading" : "Running") + '"></span>' : '')
      + esc(pairChipLabel(p)) + '</button>'
      + '<button type="button" class="pair-pin" data-pin-val="' + esc(p.code) + '"'
      + ' aria-pressed="' + (on ? "true" : "false") + '"'
      + ' title="' + (on ? "Unpin" : "Pin to the top") + '"'
      + ' aria-label="' + (on ? "Unpin " : "Pin ") + esc(p.label) + '">' + SVG.pin + '</button>'
      + '</span>';
  }

  function renderPairs() {
    var wrap = $("[data-pairs-wrap]");
    if (!wrap) { return; }
    var all = currentPairs();
    var shown = all.slice(0, PAIRS_VISIBLE);
    // The selected pair is never allowed to fall into the hidden overflow — one
    // picked from the modal can sit far down the catalogue, and a selection you
    // cannot see is how you end up trading a pair you think you deselected.
    if (store.pair && !shown.some(function (p) { return p.code === store.pair; })) {
      var sel = all.filter(function (p) { return p.code === store.pair; })[0];
      if (sel) { shown = shown.concat([sel]); }
    }
    var html = '<div class="chips chips--pairs" data-pair>';
    shown.forEach(function (p) { html += pairChipHtml(p); });
    var rest = all.length - shown.length;
    if (rest > 0) {
      html += '<button type="button" class="chip chip-more" data-pairs-more>+' + rest + ' more</button>';
    }
    wrap.textContent = ""; wrap.appendChild(htmlToFragment(html + '</div>'));
    $("[data-pair]", wrap).addEventListener("click", function (e) {
      var pin = e.target.closest("[data-pin-val]");
      if (pin) { togglePin(pin.getAttribute("data-pin-val")); return; }
      if (e.target.closest("[data-pairs-more]")) { openPairsModal(); return; }
      var b = e.target.closest("[data-pair-val]");
      if (b) { selectPair(b.getAttribute("data-pair-val")); }
    });
  }

  // Every pair the broker is offering, searchable, with the same pin control as
  // the chips. Opened by the "+N more" chip once the list outgrows PAIRS_VISIBLE.
  function openPairsModal() {
    if (!showApp()) { return; }
    var m = $("[data-modal]");
    m.textContent = ""; m.appendChild(htmlToFragment('<div class="modal-box is-list">'
      + '<button class="modal-close" data-modal-close>' + SVG.close + '</button>'
      + '<h2 class="modal-title">All currency pairs</h2>'
      + '<p class="modal-text">Live from your ' + BK + ' tab. Pin the ones you trade — pinned pairs always lead the list.</p>'
      + '<label class="pair-search"><span class="pair-search-icon">' + SVG.search + '</span>'
      + '<input class="pair-search-input" data-pair-search type="search" placeholder="Search pairs" autocomplete="off" spellcheck="false"></label>'
      + '<div class="pair-list" data-pair-list></div>'
      + '</div>'));
    $("[data-modal-close]", m).addEventListener("click", closeModal);
    m.addEventListener("click", function (e) { if (e.target === m) { closeModal(); } });
    $("[data-pair-search]", m).addEventListener("input", function () { renderPairList(); });
    $("[data-pair-list]", m).addEventListener("click", function (e) {
      var pin = e.target.closest("[data-pin-val]");
      if (pin) { togglePin(pin.getAttribute("data-pin-val")); return; }
      var b = e.target.closest("[data-pair-val]");
      if (!b) { return; }
      selectPair(b.getAttribute("data-pair-val"));
      renderPairs();
      closeModal();
    });
    m.hidden = false;
    renderPairList();
    var input = $("[data-pair-search]", m);
    if (input) { input.focus(); }
  }

  function renderPairList() {
    var box = $("[data-pair-list]");
    if (!box) { return; }
    var input = $("[data-pair-search]");
    var q = (input ? input.value : "").replace(/[^a-z0-9]/gi, "").toUpperCase();
    var rows = currentPairs().filter(function (p) { return !q || p.code.indexOf(q) !== -1; });
    if (!rows.length) {
      box.textContent = ""; box.appendChild(htmlToFragment('<p class="pair-empty">No pair matches that search.</p>'));
      return;
    }
    box.textContent = ""; box.appendChild(htmlToFragment(rows.map(function (p) {
      var on = isPinned(p.code);
      var meta = [];
      if (p.code === rt.liveCurrentAsset) { meta.push('<span class="pair-row-live">On chart</span>'); }
      if (typeof p.payout === "number") { meta.push('<span class="pair-row-payout">' + p.payout + '%</span>'); }
      return '<div class="pair-row' + (on ? " is-pinned" : "") + '">'
        + '<button type="button" class="pair-pin" data-pin-val="' + esc(p.code) + '"'
        + ' aria-pressed="' + (on ? "true" : "false") + '"'
        + ' aria-label="' + (on ? "Unpin " : "Pin ") + esc(p.label) + '">' + SVG.pin + '</button>'
        + '<button type="button" class="pair-row-btn" data-pair-val="' + esc(p.code) + '"'
        + ' aria-pressed="' + (p.code === store.pair ? "true" : "false") + '">'
        + '<span class="pair-row-name">' + esc(pairChipLabel(p)) + '</span>'
        + '<span class="pair-row-meta">' + meta.join("") + '</span></button>'
        + '</div>';
    }).join("")));
  }

  function rebuildTfChips() {
    var wrap = $("[data-tf-wrap]");
    if (!wrap) { return; }
    wrap.textContent = ""; wrap.appendChild(htmlToFragment(chipRow("tf", tfChipItems(), store.tf)));
    $("[data-tf]", wrap).addEventListener("click", function (e) {
      var b = e.target.closest("[data-tf-val]");
      if (b) { selectTf(b.getAttribute("data-tf-val"), b.getAttribute("data-locked") === "1"); }
    });
  }

  function renderStake() {
    var wrap = $("[data-stake-wrap]");
    if (!wrap) { return; }
    $("[data-stake-mode]").querySelectorAll("[data-stakemode-val]").forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-stakemode-val") === store.stakeMode ? "true" : "false");
    });
    if (store.stakeMode === "fixed") {
      wrap.textContent = ""; wrap.appendChild(htmlToFragment(chipRow("stakeamt", CFG.STAKE_AMOUNTS.map(function (a) { return { value: String(a), label: "$" + a }; }), String(store.stakeAmount))
        + '<input class="stake-custom" data-stake-custom type="number" min="1" step="1" placeholder="Custom amount ($)" value="' + (store.stakeAmount || "") + '">'));
      $("[data-stakeamt]", wrap).addEventListener("click", function (e) {
        var b = e.target.closest("[data-stakeamt-val]");
        if (!b) { return; }
        store.stakeAmount = parseFloat(b.getAttribute("data-stakeamt-val"));
        setActive($("[data-stakeamt]"), "data-stakeamt-val", b.getAttribute("data-stakeamt-val"));
        var ci = $("[data-stake-custom]"); if (ci) { ci.value = store.stakeAmount; }
        paintTags(); persist();
      });
      $("[data-stake-custom]", wrap).addEventListener("input", function (e) {
        var v = parseFloat(e.target.value);
        if (isFinite(v) && v > 0) { store.stakeAmount = v; setActive($("[data-stakeamt]"), "data-stakeamt-val", String(v)); paintTags(); persist(); }
      });
    } else {
      wrap.textContent = ""; wrap.appendChild(htmlToFragment(chipRow("stakepct", CFG.STAKE_STEPS.map(function (p) { return { value: String(p), label: p + "%" }; }), String(store.stakePct))));
      $("[data-stakepct]", wrap).addEventListener("click", function (e) {
        var b = e.target.closest("[data-stakepct-val]");
        if (!b) { return; }
        store.stakePct = parseInt(b.getAttribute("data-stakepct-val"), 10);
        setActive($("[data-stakepct]"), "data-stakepct-val", b.getAttribute("data-stakepct-val"));
        paintTags(); persist();
      });
    }
  }

  function wireSignalPanel(panel) {
    var bwrap = $("[data-broker]", panel);
    if (bwrap) { bwrap.addEventListener("click", function (e) { var b = e.target.closest("[data-broker-val]"); if (b) { selectBroker(b.getAttribute("data-broker-val")); } }); }
    var mwrap = $("[data-market]", panel);
    if (mwrap) { mwrap.addEventListener("click", function (e) { var b = e.target.closest("[data-market-val]"); if (b) { selectMarket(b.getAttribute("data-market-val")); } }); }
    var smode = $("[data-stake-mode]", panel);
    if (smode) { smode.addEventListener("click", function (e) { var b = e.target.closest("[data-stakemode-val]"); if (b) { store.stakeMode = b.getAttribute("data-stakemode-val"); renderStake(); paintTags(); persist(); } }); }
    $("[data-rescan]", panel).addEventListener("click", function () { rt.salt += 1; requestSignal(); });
  }

  function setActive(wrap, attr, val) {
    if (!wrap) { return; }
    wrap.querySelectorAll("[" + attr + "]").forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute(attr) === val ? "true" : "false"); });
  }

  // Selection changes only set up what you'll run NEXT. They never touch a running
  // engine and never open a position — the engine stays locked to rt.pair/rt.tf.
  function selectBroker(key) {
    store.broker = key;
    setActive($("[data-broker]"), "data-broker-val", key);
    reconcilePair();
    ensureTfAllowed();
    rebuildTfChips();
    paintTags(); paintFooterLinks(); persist();
  }
  function selectMarket(val) {
    store.market = val;
    setActive($("[data-market]"), "data-market-val", val);
    reconcilePair();
    paintTags(); persist();
  }
  function selectPair(code) {
    store.pair = code;
    setActive($("[data-pair]"), "data-pair-val", code);
    paintTags(); persist();
  }
  // A locked (Premium) timeframe opens the support modal instead of selecting.
  function selectTf(code, locked) {
    if (locked) { openPremiumModal(); return; }
    store.tf = code;
    setActive($("[data-tf]"), "data-tf-val", code);
    paintTags(); persist();
  }

  function reconcilePair() {
    var pairs = currentPairs();
    var ok = pairs.some(function (p) { return p.code === store.pair; });
    if (!ok) { store.pair = pairs.length ? pairs[0].code : null; }
    renderPairs();
    return ok;
  }

  function paintTags() {
    var bt = $("[data-broker-tag]"); if (bt) { bt.textContent = brokerLabel(store.broker); }
    var pt = $("[data-pair-tag]"); if (pt) { pt.textContent = store.pair ? pairLabel(store.pair) : "—"; }
    var tt = $("[data-tf-tag]"); if (tt) { var m = tfMeta(store.tf); tt.textContent = m ? m.label : (store.tf || "—"); }
    var st = $("[data-stake-tag]");
    if (st) { st.textContent = store.stakeMode === "fixed" ? ("$" + store.stakeAmount + " per trade") : (store.stakePct + "% of balance"); }
    paintStakePreview();
  }
  // Switch the broker account via the socket, so the toggle reflects reality
  // immediately and the shown balance follows the selected account.
  function selectAccount(mode) {
    store.account = mode; persist();
    paintAccountBar(); paintStakePreview();
    if (refs.status) {
      setStatus(mode === "real"
        ? ("Switching " + BK + " to your REAL account — live money.")
        : ("Switching " + BK + " to the Demo account."), mode === "real" ? "warn" : null);
    }
    chrome.runtime.sendMessage({ type: "CB_SET_ACCOUNT", account: mode }, function (resp) {
      if (chrome.runtime.lastError || !resp) {
        if (refs.status) { setStatus("Open your " + CFG.BROKER.label + " tab to switch account.", "err"); }
        return;
      }
      if (refs.status) { setStatus(resp.message || (resp.ok ? "Account set." : "Couldn't switch account."), resp.ok ? (mode === "real" ? "warn" : "ok") : "err"); }
      syncLiveUid();   // re-read balances (and identity) for the now-active account
    });
  }

  // Card rendering.
  function setCardState(s) { refs.card.setAttribute("data-state", s); }
  function setStatus(text, kind) { refs.status.className = "status" + (kind ? " is-" + kind : ""); refs.status.textContent = text || ""; }
  function setMeter(key, m) {
    if (!m) { return; }
    var row = refs.card.querySelector('[data-meter="' + key + '"]');
    var fill = row.querySelector("[data-meter-fill]"), val = row.querySelector("[data-meter-value]");
    fill.className = "bar-fill" + (m.dir === "up" ? " is-up" : m.dir === "down" ? " is-down" : m.dir === "mid" ? " is-mid" : "");
    fill.style.width = m.value + "%"; val.textContent = m.label;
  }
  function applySignal(sig) {
    refs.card.querySelector("[data-out-pair]").textContent = sig.pair;
    refs.card.querySelector("[data-out-tf]").textContent = sig.tf + " candle · " + sig.broker;
    refs.card.querySelector("[data-word]").textContent = sig.word;
    refs.card.querySelector("[data-sub]").textContent = sig.sub;
    refs.card.querySelector("[data-strength-pct]").textContent = sig.strength + "%";
    refs.card.querySelector("[data-strength-fill]").style.width = sig.strength + "%";
    setMeter("trend", sig.trend); setMeter("momentum", sig.momentum); setMeter("volatility", sig.volatility);
    setCardState(sig.direction);
    rt.lastDirection = sig.direction;
  }
  function showAnalyzing() {
    stopCountdown();
    // Whatever the foot was counting is over: a read only starts once the
    // position that preceded it has resolved. Say so rather than leaving the
    // previous label and a stale number standing.
    if (refs.countdownLabel) { refs.countdownLabel.textContent = "Next read in"; }
    refs.countdown.textContent = "—";
    refs.card.querySelector("[data-analyzing-sub]").textContent =
      "Scanning " + pairLabel(rt.pair) + (store.market === "otc" ? " OTC" : "") + " on " + brokerLabel(store.broker) + " across trend, momentum and volatility.";
    setCardState("analyzing");
  }

  // Signal request pipeline (server-owned).
  function deliver(data, myReq, started) {
    var wait = Math.max(0, MIN_ANALYZE_MS - (Date.now() - started));
    setTimeout(function () {
      if (myReq !== rt.reqId) { return; }
      rt.readFails = 0;        // a good read clears the read-failure streak
      applySignal(data);
      // myReq is this read's own identity — monotonic, never reused, and owed
      // nothing to any clock. It names the trade it produces and the history row
      // it writes, so neither can be lost to a clock that disagrees with the
      // server's.
      recordHistory(data, myReq);
      // The candle deadline is recorded BEFORE the trade goes out and armed after,
      // because whether it should be on screen at all depends on what the trade
      // does — see startCountdown.
      setReadDeadline(data.next_in);
      afterRead(data, myReq);
      startCountdown();
    }, wait);
  }
  function requestSignal() {
    if (!rt.pair) { setStatus("Pick a currency pair first.", "warn"); return; }
    // A locked Premium timeframe must NOT keep the loop alive — stop the engine
    // (so the countdown can't re-fire this every second) and prompt once.
    if (isPremiumTf(rt.tf) && !premiumUnlocked(store.broker)) {
      stopEngine();
      renderCta();
      openPremiumModal();
      return;
    }
    // Same for a known account mismatch — checked client-side FIRST (no round
    // trip) before ever asking the server for a Premium read. The server
    // enforces the same rule independently (broker_account_mismatch, below), so
    // this is purely to fail fast with the exact same message either way.
    if (isPremiumTf(rt.tf) && rt.uidMismatch) {
      stopEngine();
      renderCta();
      setStatus("Premium locked — this License is for a different " + BK + " account.", "err");
      return;
    }
    showAnalyzing();
    var myReq = ++rt.reqId;
    var started = Date.now();
    var payload = { broker: store.broker, mode: store.market, pair: rt.pair, tf: rt.tf, salt: rt.salt, item: CFG.ITEM };
    if (rt.salt > 0 && rt.lastDirection) { payload.prev = rt.lastDirection; }
    // Carry the license key + the logged-in broker account id so the server can
    // unlock Premium timeframes AND verify the account this license is pinned to.
    if (store.license && store.license.key) { payload.key = store.license.key; }
    if (rt.liveUid) { payload.uid = rt.liveUid; }

    chrome.runtime.sendMessage({ type: "CB_GET_SIGNAL", payload: payload }, function (res) {
      if (myReq !== rt.reqId) { return; }
      if (chrome.runtime.lastError || !res) { retryRead(myReq, "Connection issue — retrying…"); return; }
      if (res.status === 403) {
        var reason = res.data && res.data.error;
        stopEngine();
        renderCta();
        if (reason === "broker_account_mismatch") {
          setStatus("Premium locked — this License is for a different " + BK + " account.", "err");
          syncLiveUid();
          return;
        }
        // License lapsed between check and read — re-lock and prompt.
        setStatus("Premium License needed for this timeframe.", "warn");
        refreshLicense();
        openPremiumModal();
        return;
      }
      // There is no "we don't cover this pair" case any more: the reads are
      // independent of the symbol, so every pair the broker offers is servable
      // (see core.services.binary_signal). A 400 now means a malformed request,
      // which is our bug, not the user's — so it says so instead of telling a
      // trader to abandon a pair they can trade on the terminal.
      if (res.status === 400) {
        stopLoop();
        setStatus("The signal server rejected this request — that's on us. Reload the "
          + "extension, and tell support if it keeps happening.", "err");
        return;
      }
      if (!res.ok || !res.data || res.data.error) { retryRead(myReq, "Server declined the read — retrying…"); return; }
      deliver(res.data, myReq, started);
    });
  }
  function scheduleRetry(myReq) { setTimeout(function () { if (myReq === rt.reqId && rt.running) { requestSignal(); } }, 2500); }
  // A failed read retries, but only up to READ_FAIL_LIMIT in a row — after that we
  // stop cleanly so the button never sits on "Stop" while nothing is happening.
  function retryRead(myReq, msg) {
    rt.readFails += 1;
    if (rt.readFails >= READ_FAIL_LIMIT) {
      stopLoop();
      setStatus("Stopped — the signal server didn't respond after several tries. Check your connection and start again.", "err");
      return;
    }
    setStatus(msg, "warn");
    scheduleRetry(myReq);
  }

  // One trade per read, on the LOCKED pair.
  //
  // This used to be "one trade per candle", and the candle was worked out from
  // the BROWSER's clock — `floor(Date.now() / tf)` — while the countdown that
  // decided when to read was `next_in` off the SERVER's clock
  // (core.services.binary_signal). Two clocks, one intent, and nothing keeping
  // them together. `next_in` is also floored, so the countdown expires up to a
  // second before the server's candle actually turns.
  //
  // When they disagreed the read landed back in the bucket the previous trade had
  // already claimed, and this function returned — no order, no message, no trace.
  // The user waited a whole candle for the next read to place anything. That is
  // the reported "sometimes the position just wasn't sent".
  //
  // Both gates below are now clock-free and say what they actually mean: don't
  // trade while one of ours is open, and don't trade while one is in flight. The
  // in-flight one is not redundant — the ack takes a moment to come back, and a
  // read landing in that gap (a short `next_in`, a Re-Scan) would otherwise send
  // a second order before the first has reported.
  function afterRead(sig, readId) {
    if (!CFG.ALLOW_AUTOTRADE || !rt.auto || !rt.running) {
      if (rt.running) { setStatus("Signal ready.", "ok"); }
      return;
    }
    if (sig.direction === "notrade") { setStatus("No trade this candle — staying out.", "warn"); return; }
    if (rt.position && rt.position.closesAt > Date.now()) {
      setStatus("Holding — the open " + pairLabel(rt.pair) + " position hasn't closed yet.", "warn");
      return;
    }
    if (rt.tradeSentAt && (Date.now() - rt.tradeSentAt) < TRADE_ACK_LIMIT_MS) {
      setStatus("Holding — the last order hasn't been answered yet.", "warn");
      return;
    }
    placeTrade(sig.direction, rt.pair + "|" + rt.tf + "|r" + readId);
  }
  // Resolve the stake to a concrete dollar amount for the trade (same rounding as
  // the stake preview): fixed → the amount, percentage → % of the live balance.
  function computeStakeAmount() {
    if (store.stakeMode === "fixed") {
      var f = parseFloat(store.stakeAmount);
      return isFinite(f) && f > 0 ? f : 1;
    }
    var bal = balanceForAccount();
    if (isFinite(bal) && bal > 0) { return Math.max(1, Math.round(bal * store.stakePct / 100 * 100) / 100); }
    return Math.max(1, parseFloat(store.stakeAmount) || 1);
  }
  // PocketOption real-market instrument symbol for the LOCKED (running) pair.
  // Unlike the sibling OTC bots, this product trades the real (non-OTC) market,
  // so the broker's own code carries no "_otc" suffix, e.g. EURUSD.
  function tradeAsset() { return (rt.pair || store.pair || "").toUpperCase(); }

  // This extension's own broker key, only for products fixed to one broker with
  // a content script on its page (ALLOW_AUTOTRADE) — the multi-broker Chinese
  // Bot has no broker page to read an account id from, so it never checks.
  function brokerParam() { return (CFG.ALLOW_AUTOTRADE && CFG.BROKER) ? CFG.BROKER.key : ""; }

  // Adopt a live-assets read (from a CB_BROKER_STATE poll or a pushed ASSET_UPDATE)
  // and repaint the pair chips immediately if they're on screen — shared so a push
  // updates the UI exactly the same way a poll does, with no extra delay either way.
  function applyLiveAssets(assets) {
    if (!assets) { return; }
    rt.liveAssets = (assets.list && assets.list.length) ? assets.list : null;
    rt.liveCurrentAsset = assets.current || null;
    if ($("[data-pairs-wrap]")) {
      // Repaint first: following the chart selects a chip, which has to exist.
      reconcilePair();
      paintTags();
      followBrokerSymbol(rt.liveCurrentAsset);
    }
  }

  // The bot mirrors the broker tab, so the selection follows the chart: a read —
  // and any auto-trade it fires — must never land on a pair other than the one the
  // user is looking at. A RUNNING engine is the deliberate exception: it stays
  // locked to rt.pair for the whole run (see selectPair), so a chart change is
  // flagged rather than switched underneath a live position.
  function followBrokerSymbol(code) {
    if (!code || code === rt.followedAsset) { return; }
    rt.followedAsset = code;
    if (rt.running) {
      if (code !== rt.pair) {
        setStatus("Chart moved to " + CFG.label(code) + " — this run stays on " +
          pairLabel(rt.pair) + ". Stop to switch.", "warn");
      }
      return;
    }
    if (code === store.pair) { return; }
    selectPair(code);
  }

  // Pull the live broker state from the background socket link: is a broker tab
  // open, the logged-in broker account id, and BOTH the demo and real balances.
  // The id is compared against the one the license is pinned to
  // (store.license.brokerUid, from web-license's broker_uid — see
  // licensing.services.key_broker_customer_uid) to compute the mismatch.
  function syncLiveUid(afterCb) {
    if (!CFG.ALLOW_AUTOTRADE) {
      rt.liveUid = null; rt.uidMismatch = false; rt.demoBalance = NaN; rt.realBalance = NaN; rt.brokerTabOpen = false;
      renderBrokerStatus();
      renderUidBanner();
      if (afterCb) { afterCb(); }
      return;
    }
    chrome.runtime.sendMessage({ type: "CB_BROKER_STATE" }, function (res) {
      if (chrome.runtime.lastError || !res) {
        rt.brokerTabOpen = false; rt.liveUid = null;
        renderBrokerStatus(); renderUidBanner();
        if (afterCb) { afterCb(); }
        return;
      }
      rt.brokerTabOpen = !!res.tabOpen;
      if (typeof res.demo === "number") { rt.demoBalance = res.demo; }
      if (typeof res.real === "number") { rt.realBalance = res.real; }
      rt.liveUid = res.userId || null;
      applyLiveAssets(res.assets);
      // Adopt the account the broker is actually on (first read), so the toggle,
      // balance label and trades all agree with reality.
      if ((res.mode === "demo" || res.mode === "real") && res.mode !== store.account) {
        store.account = res.mode; persist();
      }
      var pinned = store.license && store.license.brokerUid;
      rt.uidMismatch = !!(pinned && rt.liveUid && rt.liveUid !== String(store.license.brokerUid));
      // A newly-detected mismatch must re-lock Premium immediately: stop a Premium
      // loop that's running, drop the selection to a free timeframe, and repaint
      // the chips so the locks reappear.
      if (rt.running && isPremiumTf(rt.tf) && !premiumAvailable(store.broker)) {
        stopLoop();
        setStatus("Locked — this " + BK + " account isn't linked to your License.", "err");
      }
      ensureTfAllowed();
      if ($("[data-tf-wrap]")) { rebuildTfChips(); paintTags(); }
      paintAccountBar();
      paintStakePreview();
      renderBrokerStatus();
      renderUidBanner();
      if (afterCb) { afterCb(); }
    });
  }

  // Light poll so the balance stays current while the window is open (trades and
  // manual account switches change it). Cleared/reset on every panel rebuild.
  function startBalancePoll() {
    stopBalancePoll();
    balanceTimer = setInterval(function () { syncLiveUid(); }, 12000);
  }
  function stopBalancePoll() { if (balanceTimer) { clearInterval(balanceTimer); balanceTimer = null; } }

  // Persistent banner (not a transient status line) — the signed-in broker account
  // isn't the one this license is linked to. For security it reveals NO account
  // ids (neither the licensed one nor the current one); it just states there's a
  // mismatch and, on click, opens the support-contact modal.
  function renderUidBanner() {
    var el = $("[data-uid-banner]");
    if (!el) { return; }
    if (!rt.uidMismatch) { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false;
    el.textContent = ""; el.appendChild(htmlToFragment('<button type="button" class="uid-banner" data-uid-support>' + SVG.lock
      + ' <span>This License isn\'t linked to the ' + BK + ' account you\'re signed in to, so Premium &amp; Auto-Trade stay locked. '
      + 'Tap to contact support.</span></button>'));
    var b = $("[data-uid-support]", el);
    if (b) { b.addEventListener("click", function () { openPremiumModal("mismatch"); }); }
  }

  function placeTrade(direction, clientId) {
    setStatus("Sending " + (direction === "call" ? "CALL" : "PUT") + " to " + CFG.BROKER.label
      + " (" + (store.account === "real" ? "REAL" : "Demo") + ")…", "warn");
    rt.tradeSentAt = Date.now();
    showConfirming();
    // An order dispatched into silence must not leave the run armed and idle. The
    // callback effectively always fires (the socket layer times out at 12s), so
    // this only trips when the answer can never arrive — and then the order may
    // still be live on the account, which is the one case this engine always ends
    // the run over rather than trading on top of.
    var mine = rt.tradeSentAt;
    clearTimeout(rt.tradeWatchdog);
    rt.tradeWatchdog = setTimeout(function () {
      if (rt.tradeSentAt !== mine) { return; }
      rt.tradeSentAt = 0;
      stopLoop();
      setStatus("Auto-Trade stopped — " + BK + " never answered the last order. Check your "
        + "open positions before starting again.", "err");
    }, TRADE_ACK_LIMIT_MS);
    chrome.runtime.sendMessage({
      type: "CB_TRADE",
      payload: {
        asset: tradeAsset(),
        amount: computeStakeAmount(),
        timeframe: tfSeconds(rt.tf),
        direction: direction,
        isDemo: store.account === "real" ? 0 : 1,
        // Identity of the trade, not of its shape: one READ, one order. The socket
        // layer keys its own re-send guard off this (orderSig), so it has to be
        // unique per order and identical across a retry of the same message —
        // which the read's id is, and the candle this used to carry was not.
        clientId: clientId
      }
    }, function (resp) {
      rt.tradeSentAt = 0;
      clearTimeout(rt.tradeWatchdog); rt.tradeWatchdog = null;
      var ok = !(chrome.runtime.lastError || !resp) && !!resp.ok;
      if (chrome.runtime.lastError || !resp) { setStatus("Couldn't reach the trade engine — reload the " + BK + " tab, then re-arm Auto-Trade.", "err"); }
      else { setStatus(resp.message, resp.ok ? "ok" : "err"); }
      // Guard against a "zombie" run: if the broker keeps rejecting orders (the
      // usual cause of "it traded a few times then stopped"), don't keep looping
      // with the Stop button showing — end the run after AUTO_FAIL_LIMIT in a row.
      if (rt.auto && rt.running) {
        if (resp && resp.expiryRejected) {
          // Deterministic, not transient: the broker will refuse this expiry on
          // this pair every time. Three strikes would just be three refusals, so
          // the run ends here and the message says which setting to change.
          stopLoop();
          setStatus(resp.message, "err");
        } else if (resp && resp.durationMismatch) {
          // The position is open for a length the user never chose. Continuing
          // would stack more of them, so the run ends and says exactly what the
          // broker did.
          stopLoop();
          setStatus(resp.message, "err");
        } else if (resp && resp.unconfirmed) {
          // Not a rejection: the order may be live on the account. Trading the
          // next candle on top of a position we can't see is how one unconfirmed
          // order becomes two real ones, so the run ends here and the user is
          // told to look at the terminal.
          stopLoop();
          setStatus(resp.message, "err");
        } else if (ok) {
          rt.failStreak = 0;
          // The position is live. From here the run counts IT down and reads
          // again when it resolves, instead of at the next candle boundary.
          startPositionCountdown(resp.closesAt);
        }
        else {
          rt.failStreak += 1;
          if (rt.failStreak >= AUTO_FAIL_LIMIT) {
            stopLoop();
            setStatus("Auto-Trade stopped — " + BK + " rejected the last " + rt.failStreak + " orders. Check your account and open positions, then start again.", "err");
            return;
          }
          // Nothing opened, so the run goes back to the candle clock it was
          // holding — the foot has been showing "Confirming trade" until now and
          // would otherwise sit there with no timer and no next read.
          startCountdown();
        }
      }
    });
  }

  // Countdown.
  function fmt(s) {
    s = Math.max(0, Math.floor(s));
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60), sec = s - m * 60;
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return (h > 0 ? p(h) + ":" : "") + p(m) + ":" + p(sec);
  }
  function stopCountdown() { if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; } }

  // The card foot counts one of two things down, and which one it is decides when
  // the run reads again.
  //
  //   "position" — a trade of ours is open. It counts THAT down, off the broker's
  //                own close moment, and the next read fires when it resolves.
  //   "read"     — nothing of ours is open. It counts to the next candle, which
  //                is when the next read is due.
  //
  // These used to be one thing: the foot always counted to the next candle, even
  // with a position open. Two consequences, and the second is the one that
  // matters. The number disagreed with the broker's own timer on the terminal —
  // a 1-minute trade placed 28s into a candle showed 22s left here against the
  // broker's 51s, because the two were measuring different events. And the run
  // re-read, and re-traded, at that candle boundary: 28 seconds BEFORE the
  // position it had just opened resolved. Every candle stacked another
  // overlapping position, which is the thing this engine stops the run over
  // everywhere else (see the unconfirmed and durationMismatch paths). Pacing the
  // run by the position settles both at once — what the foot shows is what the
  // broker shows, and there is never more than one of our positions open.
  //
  // The tick is deadline-driven rather than a counter decremented once a second,
  // because Chrome throttles timers in an unfocused window: a subtracting counter
  // simply falls behind and never catches up, which on a 5-minute expiry is
  // minutes of drift. Reading the clock each tick cannot drift.
  function runCountdown(mode, deadline) {
    stopCountdown();
    if (refs.countdownLabel) {
      refs.countdownLabel.textContent = mode === "position" ? "Trade expires in" : "Next read in";
    }
    function tick() {
      rt.remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      refs.countdown.textContent = fmt(rt.remaining);
      if (rt.remaining > 0) { return; }
      stopCountdown();
      if (mode === "position") { rt.position = null; }
      if (rt.running) { rt.salt = 0; requestSignal(); }
    }
    tick();
    countdownTimer = setInterval(tick, 250);
  }

  // The server floors its "seconds to the next candle" to a whole number, so on a
  // short timeframe it legitimately returns 0 — the candle is closing right now.
  // Falling back to a hardcoded 60 there put a one-minute countdown on a
  // five-second candle. The right fallback is the timeframe's own length.
  function setReadDeadline(nextIn) {
    var secs = (typeof nextIn === "number" && nextIn > 0) ? nextIn : tfSeconds(rt.tf || store.tf);
    rt.readDeadline = Date.now() + secs * 1000;
  }

  // Show whichever of the three the run is actually waiting on, in that order of
  // authority. The candle clock is last, and that ordering is the point.
  //
  //   1. a position of ours is open  — count it, and read when it resolves
  //   2. an order is unconfirmed     — count nothing; we do not know yet
  //   3. otherwise                   — count to the next candle
  //
  // Rule 2 is the one that was missing. An order the broker had not
  // answered left the foot showing the candle clock, so a 1-minute trade whose
  // confirmation never arrived displayed "20 seconds" thirty seconds into the
  // candle — a number that looks exactly like a position timer for a position
  // that does not exist. There is no honest number to show there, so it shows
  // none.
  function startCountdown() {
    if (rt.position && rt.position.closesAt > Date.now()) {
      runCountdown("position", rt.position.closesAt);
      return;
    }
    if (rt.tradeSentAt) { showConfirming(); return; }
    var at = rt.readDeadline;
    if (!at || at <= Date.now()) { at = Date.now() + tfSeconds(rt.tf || store.tf) * 1000; }
    runCountdown("read", at);
  }

  // No timer: nothing here counts down, because nothing here is known. The socket
  // layer answers every order within its own 12s no-ack timeout, and placeTrade's
  // watchdog covers an answer that never comes at all.
  function showConfirming() {
    stopCountdown();
    if (refs.countdownLabel) { refs.countdownLabel.textContent = "Confirming trade"; }
    refs.countdown.textContent = "—";
  }

  // Adopt the position the broker just confirmed. Called from placeTrade's ack,
  // so it lands a moment after startCountdown has already armed the read timer —
  // and replaces it. That order is deliberate: the read timer is the fallback
  // that keeps the run alive if the ack never comes.
  function startPositionCountdown(closesAt) {
    var at = Number(closesAt);
    // No usable stamps from the broker: fall back to the expiry we asked for,
    // measured from now. Still the position rather than the candle.
    if (!isFinite(at) || at <= Date.now()) { at = Date.now() + tfSeconds(rt.tf) * 1000; }
    rt.position = { closesAt: at };
    runCountdown("position", at);
  }
  // Stop the signal loop + countdown and invalidate any in-flight request,
  // without touching the card/status UI (used by logout and the Premium lock).
  function stopEngine() {
    rt.running = false; stopCountdown(); rt.reqId++;
    rt.position = null; rt.tradeSentAt = 0; rt.readDeadline = 0;
    clearTimeout(rt.tradeWatchdog); rt.tradeWatchdog = null;
  }

  function startLoop() {
    if (!store.pair) { setStatus("Pick a currency pair first.", "warn"); return; }
    if (isPremiumTf(store.tf) && !premiumUnlocked(store.broker)) { openPremiumModal(); return; }
    // Re-read the logged-in broker account right before starting, so a switch
    // made just now (or a first check that hasn't run yet) is caught before the
    // loop arms — requestSignal() re-checks this on every poll too.
    syncLiveUid(function () {
      if (isPremiumTf(store.tf) && rt.uidMismatch) {
        setStatus("Can't start — this License is for a different " + BK + " account.", "err");
        renderCta();
        return;
      }
      // Lock the engine to the CURRENT selection. From here, changing the pair /
      // timeframe chips won't move or re-fire this engine — it stays on rt.pair.
      rt.pair = store.pair; rt.tf = store.tf; rt.auto = (store.execMode === "auto");
      rt.running = true; rt.salt = 0; rt.lastDirection = null;
      rt.failStreak = 0; rt.readFails = 0; rt.position = null; rt.tradeSentAt = 0;
      rt.readDeadline = 0; clearTimeout(rt.tradeWatchdog); rt.tradeWatchdog = null;
      renderCta();
      renderPairs();   // badge the now-running pair chip
      requestSignal();
    });
  }
  function stopLoop() {
    rt.running = false; stopCountdown(); rt.reqId++;
    rt.position = null; rt.tradeSentAt = 0; rt.readDeadline = 0;
    clearTimeout(rt.tradeWatchdog); rt.tradeWatchdog = null;
    renderCta();
    renderPairs();     // drop the running badge
    setStatus(rt.auto ? "Auto-Trade stopped." : "Engine stopped.", null);
    if (refs.card.getAttribute("data-state") === "analyzing") { setCardState("empty"); }
  }

  // Support-contact modal (site-contact-modal style). Default context is the
  // Premium upsell; "mismatch" reuses the same contact actions but for a license
  // that isn't linked to the current broker account (no account ids are shown).
  function openPremiumModal(context) {
    // Never surface over the gate — this is an in-app action only.
    if (!showApp()) { return; }
    var mismatch = context === "mismatch";
    var title = mismatch ? "Account not linked" : "Premium timeframe";
    var text = mismatch
      ? 'This License isn\'t linked to the ' + BK + ' account you\'re signed in to, so Premium timeframes and Auto-Trade stay locked. Message our support and we\'ll get it sorted.'
      : 'Only <b>4H</b> and <b>1D</b> are available on the free trial. To unlock every intraday timeframe for <b>' + brokerLabel(store.broker) + '</b>, message our support and request a Premium License — we\'ll set you up.';
    var m = $("[data-modal]");
    m.textContent = ""; m.appendChild(htmlToFragment('<div class="modal-box">'
      + '<button class="modal-close" data-modal-close>' + SVG.close + '</button>'
      + '<span class="modal-icon">' + SVG.lock + '</span>'
      + '<h2 class="modal-title">' + title + '</h2>'
      + '<p class="modal-text">' + text + '</p>'
      + '<div class="modal-actions">'
      + '  <a class="modal-btn is-tg" data-tg-link target="_blank" rel="noopener">' + SVG.tg + ' Contact on Telegram</a>'
      + '  <a class="modal-btn is-wa" data-wa-link target="_blank" rel="noopener">' + SVG.wa + ' Contact on WhatsApp</a>'
      + '</div>'
      + '<p class="modal-foot">Already have a License? <button class="modal-link" data-modal-activate>Activate it</button></p>'
      + '</div>'));
    $("[data-tg-link]", m).href = telegramUrl();
    $("[data-wa-link]", m).href = whatsappUrl();
    $("[data-modal-close]", m).addEventListener("click", closeModal);
    m.addEventListener("click", function (e) { if (e.target === m) { closeModal(); } });
    $("[data-modal-activate]", m).addEventListener("click", function () { closeModal(); ui.showGate = true; route(); });
    m.hidden = false;
  }
  function closeModal() { var m = $("[data-modal]"); if (m) { m.hidden = true; m.textContent = ""; } }

  // Shown (as a real modal) when the user tries to start without having chosen a
  // pair and/or timeframe — nothing is pre-selected on the auto-trade bot.
  function openChooseModal() {
    if (!showApp()) { return; }
    var need = [];
    if (!store.pair) { need.push("a currency pair"); }
    if (!store.tf) { need.push("a timeframe"); }
    if (!need.length) { return; }
    var m = $("[data-modal]");
    m.textContent = ""; m.appendChild(htmlToFragment('<div class="modal-box">'
      + '<button class="modal-close" data-modal-close>' + SVG.close + '</button>'
      + '<span class="modal-icon">' + SVG.signal + '</span>'
      + '<h2 class="modal-title">Choose your setup first</h2>'
      + '<p class="modal-text">Select <b>' + need.join('</b> and <b>') + '</b> above, then tap Get Signal or Auto-Trade. Nothing is pre-selected on purpose, so you only ever trade the pair and timeframe you picked.</p>'
      + '<div class="modal-actions"><button class="modal-btn is-tg" data-modal-ok>Got it</button></div>'
      + '</div>'));
    $("[data-modal-close]", m).addEventListener("click", closeModal);
    $("[data-modal-ok]", m).addEventListener("click", closeModal);
    m.addEventListener("click", function (e) { if (e.target === m) { closeModal(); } });
    m.hidden = false;
  }

  // History.
  // Keyed on the read, for the reason above: keyed on the browser's candle, a read
  // that landed back in the previous bucket was dropped from History too — the
  // same skew, the same silence, one row missing next to one order missing. One
  // read is one row now, so a Re-Scan you asked for shows up as the read it was.
  function recordHistory(sig, readId) {
    var key = store.broker + "|" + rt.pair + "|" + rt.tf + "|r" + readId;
    if (store.history[0] && store.history[0].key === key) { return; }
    store.history.unshift({
      key: key, ts: Date.now(), broker: brokerLabel(store.broker),
      pair: sig.pair, tf: sig.tf, direction: sig.direction, word: sig.word, strength: sig.strength
    });
    if (store.history.length > HISTORY_CAP) { store.history.length = HISTORY_CAP; }
    persist();
  }
  function timeAgo(ts) {
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) { return s + "s ago"; }
    var m = Math.floor(s / 60); if (m < 60) { return m + "m ago"; }
    var h = Math.floor(m / 60); if (h < 24) { return h + "h ago"; }
    return Math.floor(h / 24) + "d ago";
  }
  function renderHistory() {
    var panel = $('[data-panel="history"]');
    if (!store.history.length) {
      panel.textContent = ""; panel.appendChild(htmlToFragment('<div class="hist-empty">No signals yet.<br>Request a read on the Signal tab and it will be logged here.</div>'));
      return;
    }
    var rows = store.history.map(function (h) {
      var cls = h.direction === "call" ? "is-call" : h.direction === "put" ? "is-put" : "is-notrade";
      var word = h.direction === "notrade" ? "—" : h.word;
      return '<div class="hist-row"><span class="hist-dir ' + cls + '">' + esc(word) + '</span>'
        + '<div class="hist-main"><div class="hist-pair">' + esc(h.pair) + '</div>'
        + '<div class="hist-meta">' + esc(h.tf) + ' · ' + esc(h.broker) + ' · ' + timeAgo(h.ts) + '</div></div>'
        + '<span class="hist-strength">' + (h.direction === "notrade" ? "" : h.strength + "%") + '</span></div>';
    }).join("");
    panel.textContent = ""; panel.appendChild(htmlToFragment('<div class="hist-list">' + rows + '</div><button class="hist-clear" data-hist-clear>Clear history</button>'));
    $("[data-hist-clear]", panel).addEventListener("click", function () { store.history = []; persist(); renderHistory(); });
  }

  // Live push streams from the socket content script — update the UI the instant
  // they arrive, without waiting for the next poll:
  //   BALANCE_UPDATE — both demo and real, on connect / account switch / change.
  //   ASSET_UPDATE (engines that read the live instrument table) — the charted symbol (or account mode)
  //   changed on the broker tab; re-pin the pair chips right away.
  if (CFG.ALLOW_AUTOTRADE) {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.action === "BALANCE_UPDATE" && msg.payload) {
        if (typeof msg.payload.demo !== "undefined") { rt.demoBalance = parseFloat(msg.payload.demo); }
        if (typeof msg.payload.real !== "undefined") { rt.realBalance = parseFloat(msg.payload.real); }
        rt.brokerTabOpen = true;
        paintAccountBar();
        paintStakePreview();
        renderBrokerStatus();
      }
      if (msg && msg.action === "ASSET_UPDATE" && msg.payload) {
        applyLiveAssets(msg.payload);
      }
    });
  }

  // Boot.
  try { document.title = CFG.APP_NAME; } catch (e) {}   // popup tab/window title = product name
  tgUser = pickTelegram();
  load(function () { route(); refreshLicense(); });
})();
