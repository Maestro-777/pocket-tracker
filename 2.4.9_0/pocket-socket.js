/*
 * SignalBots — PocketOption real-market broker link (content script).
 *
 * Same engine as the sibling PocketOption OTC bot (pocket-otc-bot), forked to
 * trade the real (non-OTC) market instead: no "_otc" suffix on the traded asset,
 * and GET_ASSETS keeps the non-OTC rows out of the broker's instrument table
 * rather than the OTC ones. See below.
 *
 * Written from scratch. PocketOption exposes account identity, live balances and
 * trade placement ONLY over its own realtime socket — the DOM is React-rendered
 * and unscrapable — and it speaks a HAND-ROLLED Engine.IO v4 / Socket.IO v4
 * dialect (not the socket.io-client library). So this file is a small, dependency
 * -free EIO4/SIO4 client that:
 *   1. reads the logged-in session from the page (window.AppData, injected as an
 *      inline <script>; falls back to the ci_session cookie for the real-account
 *      session token),
 *   2. races the page's advertised socket servers and keeps the first that opens,
 *   3. authorises with { session, uid, isDemo } via the "auth" event,
 *   4. streams demo + real balances (TotalBalance / successupdateBalance),
 *   5. places CALL/PUT orders (openOrder) and resolves on the broker's ack,
 *   6. switches demo<->real by re-keying the session (the broker mints a
 *      different token per mode) and reconnecting.
 *
 * It exposes the SAME chrome-message contract the shared background.js drives for
 * every OTC bot: GET_CREDENTIALS / CONNECT_WS / ACCOUNT_MODE_UPDATE / OPEN_TRADE,
 * and pushes BALANCE_UPDATE. Nothing here talks to signalbots.ai — signals and
 * licensing stay in background.js. See quotex-otc-bot for the reference contract.
 *
 * GET_ASSETS is PocketOption-specific: it reports the live real-market pair list
 * so the popup's pair chips mirror what's actually tradeable on the user's
 * PocketOption tab, instead of the static config.js STATIC_PAIRS list. It has
 * three sources, in falling order of authority:
 *   1. the broker's own `updateAssets` push, captured off the PAGE's socket by the
 *      main-world tap (po-tap.js) — always live, carries payouts, needs no picker
 *      panel open and no second connection,
 *   2. the same event on OUR socket, once authorised,
 *   3. the currency-pair picker's DOM, which only exists while the user has that
 *      panel open, so it contributes the broker's visual order when available.
 * `updateAssets` is delivered as a Socket.IO BINARY attachment event; the frame
 * reader below decodes those, which an earlier build did not — which is why the
 * list looked as though the broker never sent one.
 */
(function () {
  "use strict";

  // A PocketOption tab can already carry this script from a prior inject; never
  // wire the socket or the message listener twice.
  if (window.__SB_POCKET_SOCKET__) { return; }
  window.__SB_POCKET_SOCKET__ = true;

  var APPDATA_KEY = "AppData";

  // Live link state. `mode` is the account the socket is currently authorised for;
  // balances are cached per account so the popup can show both at once.
  // The page's own socket, seen by po-tap.js. On Firefox it is the only transport
  // that reliably works: a Manifest V3 content script's WebSocket is made in the
  // page's context where a "*://" host permission does not cover a wss:// URL, and
  // PocketOption publishes its socket servers at RUNTIME on hosts no manifest can
  // have listed in advance. That socket is already connected to whichever server
  // the broker chose, and already authorised.
  var page = { socket: false, via: false, creds: null };

  var link = {
    sock: null,          // PocketSocket instance (null until CONNECT_WS)
    creds: null,         // last derived credentials
    mode: null,          // "demo" | "real"
    authed: false,
    authConfirmed: false,   // broker answered our auth with successauth
    connecting: null,    // in-flight connect promise (dedupe)
    demo: NaN,
    real: NaN
  };

  // Pending orders keyed by requestId -> { resolve, timer }. Resolved by the
  // broker's openOrder (success) / failopenOrder (rejection) events.
  var pending = {};

  // Monotonic, unique, positive-integer request ids. Seeded from the clock so ids
  // stay roughly time-ordered, but never collide even for same-millisecond orders
  // (Date.now() alone would, and PocketOption keys its ack by requestId).
  var reqSeq = Date.now();

  // Guard against the shared background.js re-sending an identical OPEN_TRADE after
  // a transient socket drop: while the same order is in flight — or settled within
  // DEDUP_MS — reuse its result instead of placing a second real trade. (A full
  // tab reload wipes this map; that residual double-trade edge is inherent to the
  // auto-trade design and documented in the README.)
  //
  // The key is the caller's `clientId` when it sends one, NOT the order's shape.
  // Keying on shape meant two CONSECUTIVE orders that happened to signal the same
  // direction looked identical, so on a short timeframe — where they land closer
  // together than the dedup window — the second was silently swallowed and its
  // result reported as the first one's.
  //
  // What makes that safe is entirely a property of the id the caller picks, so it
  // is worth stating: it must be unique per ORDER and identical across a retry of
  // the same message. The popup used to derive it from the browser's candle
  // clock, which is neither — two reads either side of a clock disagreement
  // produced the same id and the second order vanished here exactly as it did
  // upstream. It now sends the id of the read that produced the order.
  var DEDUP_MS = 4000;
  var recent = {};
  function orderSig(p) {
    if (p.clientId) { return "cid:" + p.clientId; }
    return p.asset + "|" + p.direction + "|" + (p.isDemo ? 1 : 0) + "|" + p.timeframe;
  }
  // With a clientId the window only has to cover a re-send of the SAME order, so
  // it never has to outlive the expiry itself. Without one, fall back to the old
  // fixed window but never let it exceed half the expiry, or a short timeframe
  // would keep eating its own next trade.
  function dedupWindow(p) {
    var tf = Number(p.timeframe) || 0;
    if (p.clientId) { return Math.min(DEDUP_MS, tf ? tf * 1000 : DEDUP_MS); }
    return tf ? Math.min(DEDUP_MS, Math.floor(tf * 1000 / 2)) : DEDUP_MS;
  }
  // Ids are unique per order now rather than reused per candle, so nothing ever
  // overwrites an old entry. Drop the settled ones that are past every window
  // they could still be guarding, or a session left running all day keeps one
  // per trade for no reason.
  function pruneRecent(now) {
    Object.keys(recent).forEach(function (k) {
      var e = recent[k];
      if (!e.pending && (now - e.ts) > DEDUP_MS) { delete recent[k]; }
    });
  }

  // Expiries PocketOption has actually refused, keyed "<ASSET>|<seconds>". The
  // broker answers an unsupported expiry with `failopenOrder` carrying
  // `error: "IncorrectExpTime"` and opens nothing — its real-market assets do
  // not take the sub-minute expiries its OTC assets do. That is a property of
  // the instrument, not a transient failure, so re-sending the same order can
  // only earn the same refusal: once seen, the pair is remembered and every
  // later order for it is refused here instead of on the account. Cleared by a
  // tab reload, which is the right lifetime — the broker's instrument table is
  // re-read then too.
  var EXPIRY_REJECTED = "IncorrectExpTime";
  var badExpiry = {};
  function expiryKey(asset, seconds) { return String(asset).toUpperCase() + "|" + seconds; }
  function isExpiryError(reason) {
    return new RegExp(EXPIRY_REJECTED, "i").test(String(reason || ""));
  }

  // Credentials — read the broker session straight off the page.

  // The real-account session token lives in the ci_session cookie (URL-encoded).
  function readCiSession() {
    var row = (document.cookie || "").split("; ").filter(function (c) {
      return c.indexOf("ci_session=") === 0;
    })[0];
    if (!row) { return ""; }
    try { return decodeURIComponent(row.split("=")[1] || ""); }
    catch (e) { return row.split("=")[1] || ""; }
  }

  // Extract the first balanced { ... } object literal that follows `key` inside a
  // block of JS source, respecting string literals so a "}" inside a string never
  // ends the scan. Returns the substring or null.
  function extractObjectLiteral(src, key) {
    var at = src.indexOf(key);
    if (at === -1) { return null; }
    var start = src.indexOf("{", at);
    if (start === -1) { return null; }
    var depth = 0, inStr = false, quote = "", esc = false;
    for (var i = start; i < src.length; i++) {
      var ch = src[i];
      if (inStr) {
        if (esc) { esc = false; }
        else if (ch === "\\") { esc = true; }
        else if (ch === quote) { inStr = false; }
        continue;
      }
      if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue; }
      if (ch === "{") { depth++; }
      else if (ch === "}") { depth--; if (depth === 0) { return src.slice(start, i + 1); } }
    }
    return null;
  }

  // Find window.AppData by scanning the page's inline <script> tags (the content
  // script's isolated world can't read window.AppData directly). `srcText` lets
  // the mode-switch path parse AppData out of a freshly fetched cabinet page.
  function extractAppData(srcText) {
    if (typeof srcText === "string") {
      var lit = extractObjectLiteral(srcText, APPDATA_KEY);
      if (lit) { try { return JSON.parse(lit); } catch (e) {} }
      return null;
    }
    var tags = document.querySelectorAll("script");
    for (var i = 0; i < tags.length; i++) {
      var t = tags[i].textContent;
      if (!t || t.indexOf(APPDATA_KEY) === -1) { continue; }
      var l = extractObjectLiteral(t, APPDATA_KEY);
      if (l) { try { return JSON.parse(l); } catch (e) {} }
    }
    return null;
  }

  // Real accounts aren't always USD — PocketOption keys the live balance by the
  // account's actual currency (e.g. "balance-real-UAH"). Take the first
  // "balance-real-*" entry instead of assuming "balance-real-USD", so a non-USD
  // account still gets a seed balance instead of showing "—" until the socket's
  // first TotalBalance event arrives.
  function firstRealBalance(balances) {
    var keys = Object.keys(balances);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf("balance-real-") === 0 && typeof balances[keys[i]] === "number") {
        return balances[keys[i]];
      }
    }
    return NaN;
  }

  // Turn a raw AppData blob into the credential shape the socket auth needs.
  // Demo uses AppData.demoSessionId; real falls back to the ci_session cookie.
  function deriveCreds(app) {
    if (!app) { return null; }
    var isDemo = !!app["is-demo"];
    var session = (isDemo && app.demoSessionId) ? app.demoSessionId : readCiSession();
    if (!session) { return null; }
    var listRaw = app["servers-list"] || app["try-demo-servers-list"] || [];
    var servers = [];
    for (var i = 0; i < listRaw.length; i++) {
      // Entries are normally { server: "wss://..." }, but tolerate a plain host
      // string too in case PocketOption ever flattens the list shape.
      var raw = listRaw[i];
      var s = typeof raw === "string" ? raw : (raw && raw.server);
      if (typeof s === "string" && s.length && servers.indexOf(s) === -1) { servers.push(s); }
    }
    var balances = app.balances || {};
    return {
      uid: app.uid,
      userId: app.uid != null ? String(app.uid) : null,
      isDemo: isDemo,
      platform: app.platform,
      session: session,
      serverUrls: servers,
      siteUrl: app["site-url"] || (location.origin + "/"),
      seedReal: firstRealBalance(balances),
      seedDemo: typeof balances["balance-demo"] === "number" ? balances["balance-demo"] : NaN
    };
  }

  // The credentials the socket auth needs, from the page's own markup if it can be
  // read and from the page's own auth frame if it cannot.
  //
  // The AppData path is the primary one: it carries the balances and the
  // servers-list as well. But it is also the single point of failure that made
  // this extension look dead on Firefox - no AppData literal, or a real account
  // whose ci_session cookie is not readable, and deriveCreds returns null, so the
  // worker never gets a uid and gives up before opening anything. The page is
  // authenticating on its own socket with the uid, the session and the account it
  // is on, so that is the fallback (see po-tap.js onPageAuth).
  function currentCreds() {
    var app = deriveCreds(extractAppData());
    if (app) {
      // Even with AppData in hand, the page's own frame is the better authority on
      // WHICH account the session belongs to.
      if (page.creds && page.creds.session === app.session) { app.isDemo = page.creds.isDemo; }
      return app;
    }
    if (!page.creds) { return null; }
    console.log("[SignalBots] PocketOption AppData was unreadable — using the identity the "
      + "page authenticated with (uid " + page.creds.uid + ").");
    return {
      uid: page.creds.uid,
      userId: String(page.creds.uid),
      isDemo: page.creds.isDemo,
      platform: page.creds.platform,
      session: page.creds.session,
      // No server list without AppData. raceServers falls back to the page's own
      // host, and when that cannot be reached - which on Firefox is the norm - the
      // engine adopts the page's socket, which is where this identity came from.
      serverUrls: [],
      siteUrl: location.origin + "/",
      seedReal: NaN,
      seedDemo: NaN
    };
  }

  // Live real-market pair list — read straight off PocketOption's own currency-pair picker
  // (DOM, not the socket) so the extension always offers exactly what the broker
  // shows right now, in the broker's own order, instead of a list fixed at build
  // time. The full picker panel only exists in the DOM while the user has it open
  // on the page; `assetCache` keeps the last successful read per account mode so a
  // later request (picker closed, or on the other account) still has something to
  // offer instead of going blank — demo and real can show different favorites/
  // current symbol/open pairs, so they're never allowed to share one cache.
  var assetCache = {
    demo: { current: null, list: [], scannedAt: 0 },
    real: { current: null, list: [], scannedAt: 0 }
  };

  // "AUD/CHF OTC" -> { code: "AUDCHF", label: "AUD/CHF", otc: true }.
  function parsePairSpan(text) {
    var t = (text || "").replace(/\s+/g, " ").trim();
    var otc = /\bOTC\b/i.test(t);
    var label = t.replace(/\s*OTC\s*$/i, "").trim();
    var code = label.replace(/\//g, "").toUpperCase();
    if (!/^[A-Z0-9]{4,10}$/.test(code)) { return null; }
    return { code: code, label: label, otc: otc };
  }

  // The symbol currently loaded on the chart — a single header element, always
  // mounted regardless of whether the picker panel is open.
  function scanCurrentSymbol() {
    var el = document.querySelector(".currencies-block .current-symbol");
    return el ? parsePairSpan(el.textContent) : null;
  }

  // The full picker list, in the broker's own visual (= DOM) order. Each row's
  // class carries an "alist__item--no-active" modifier when that pair is closed
  // right now (weekend/off-hours) — checked as an exact class token, not a
  // substring match, since "no-active" itself contains "active".
  function scanAssetList() {
    var items = document.querySelectorAll(".alist.alist-currency .alist__item");
    if (!items.length) { return null; }
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      var labelEl = el.querySelector(".alist__label");
      var p = labelEl ? parsePairSpan(labelEl.textContent) : null;
      if (!p) { continue; }
      var closed = false;
      for (var j = 0; j < el.classList.length; j++) {
        if (el.classList[j].indexOf("alist__item--no-active") === 0) { closed = true; break; }
      }
      p.closed = closed;
      out.push(p);
    }
    return out;
  }

  // The broker's own instrument table, from `updateAssets` on either the page's
  // socket (via po-tap.js) or ours. Account-mode independent — PocketOption pushes
  // one table per connection covering everything tradeable — so it is stored once
  // rather than per mode.
  var socketAssets = { list: [], at: 0, current: null, currentAt: 0 };

  function labelFor(code, name) {
    if (name) {
      var p = parsePairSpan(name);
      if (p && p.code === code) { return p.label; }
    }
    return code.length === 6 ? (code.slice(0, 3) + "/" + code.slice(3)) : code;
  }

  // Slimmed `updateAssets` rows (see po-tap.js for the positional schema) reduced
  // to the open REAL-market pairs (no "_otc" suffix), richest payout first — the
  // order PocketOption's own picker defaults to, used whenever no fresh DOM scan
  // supplies the visual order. This product trades the real market, unlike the
  // sibling OTC bots, so it keeps the non-OTC rows and drops the OTC ones.
  function socketRealPairs() {
    var out = [], seen = {};
    for (var i = 0; i < socketAssets.list.length; i++) {
      var a = socketAssets.list[i];
      if (!a || a.otc || a.open === false) { continue; }
      var code = String(a.code || "").toUpperCase();
      if (!/^[A-Z0-9]{4,10}$/.test(code) || seen[code]) { continue; }
      seen[code] = 1;
      out.push({ code: code, label: labelFor(code, a.name), payout: a.payout });
    }
    out.sort(function (x, y) { return (y.payout || 0) - (x.payout || 0); });
    return out;
  }

  // One `updateAssets` row is a long positional array: [1] the instrument symbol,
  // [2] its display name and [5] the current payout are the positions PocketOption's
  // own client relies on. Whether the instrument is open right now sits in a boolean
  // whose index is not stable across builds, so it is only trusted when the row
  // carries exactly one — a wrongly-open pair merely fails to trade, while a
  // wrongly-closed one would disappear from the list. Mirrors po-tap.js.
  // A broker symbol that is not symbol-shaped is not a symbol. Everything here
  // arrives as text off PocketOption's socket and ends up interpolated into the
  // popup's markup, which runs with extension privileges — so the shape is
  // checked where it enters rather than trusted all the way to the DOM. (The
  // popup escapes it at the other end too; neither alone is the whole answer.)
  function isSymbolShaped(sym) {
    return typeof sym === "string" && /^[A-Za-z0-9._\/-]{1,32}$/.test(sym);
  }

  function slimAssetRows(rows) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!Array.isArray(r) || r.length < 6 || !isSymbolShaped(r[1])) { continue; }
      var found = null, count = 0;
      for (var k = 0; k < r.length; k++) {
        if (typeof r[k] === "boolean") { count++; found = r[k]; }
      }
      out.push({
        symbol: r[1],
        code: r[1].replace(/_otc$/i, "").toUpperCase(),
        otc: /_otc$/i.test(r[1]),
        name: typeof r[2] === "string" ? r[2] : null,
        payout: typeof r[5] === "number" ? r[5] : null,
        open: count === 1 ? found : true
      });
    }
    return out;
  }

  function adoptSocketAssets(list) {
    if (!list || !list.length) { return; }
    socketAssets.list = list;
    socketAssets.at = Date.now();
    console.log("[SignalBots] PocketOption updateAssets adopted:", list.length, "rows,",
      socketRealPairs().length, "open real-market pairs");
    schedulePush(true);
  }

  // The main-world tap forwards the page socket's own pushes. Its listener has to
  // be installed before the snapshot request below, since the tap replays into the
  // same channel.
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) { return; }
    var d = ev.data;
    if (!d || d.__sb !== "SB_PO_TAP" || !d.event) { return; }
    if (d.event === "creds" && d.payload) {
      // Shape-checked here as well as in the tap: this arrives over postMessage,
      // which the page itself could write to.
      var c = d.payload;
      if (c.uid != null && typeof c.session === "string" && c.session) {
        page.creds = { uid: c.uid, session: c.session, isDemo: !!c.isDemo, platform: c.platform };
      }
      return;
    }
    if (d.event === "socket" && d.payload) {
      page.socket = !!d.payload.open;
      if (!page.socket && page.via) {
        // The transport this engine was running on has gone.
        page.via = false;
        link.authed = false;
      }
      return;
    }
    if (d.event === "balance" && d.payload) {
      var b = d.payload;
      if (typeof b.balance === "number" && isFinite(b.balance)) {
        if (b.isDemo === 1) { link.demo = b.balance; }
        else if (b.isDemo === 0) { link.real = b.balance; }
        pushBalance();
      }
      return;
    }
    if (d.event === "assets" && d.payload) { adoptSocketAssets(d.payload.list); return; }

    if (d.event === "orderAck" && d.payload) {
      acceptOrderAck(d.payload, d.payload.ok, "the page's socket");
      return;
    }
    if (d.event === "symbol" && d.payload && d.payload.current) {
      if (!isSymbolShaped(d.payload.current)) { return; }
      socketAssets.current = String(d.payload.current).toUpperCase();
      socketAssets.currentAt = Date.now();
      schedulePush(false);
    }
  });
  // The tap starts at document_start and this script at document_idle, so ask it
  // to replay whatever it captured in between.
  try { window.postMessage({ __sb: "SB_PO_TAP", req: "SNAPSHOT" }, "*"); } catch (e) {}

  // Rescan the page and refresh the cache for whichever account mode is active
  // right now (read straight from AppData, not from the socket, so this works even
  // before the socket has authorised); always return the best data available.
  // Real-market-only and open-only — trading a closed pair would just fail —
  // deduped. The DOM scan, when the picker happens to be open, supplies the
  // broker's visual order; every pair the broker reports but the DOM didn't cover
  // is appended behind it, so the list is complete either way instead of empty.
  function liveAssets() {
    var app = extractAppData();
    var mode = (app && app["is-demo"]) ? "demo" : "real";
    var cache = assetCache[mode];
    var cur = scanCurrentSymbol();
    var list = scanAssetList();
    if (list && list.length) { cache.current = cur; cache.list = list; cache.scannedAt = Date.now(); }
    else if (cur) { cache.current = cur; cache.scannedAt = Date.now(); }
    // Only the broker's own instrument table carries payouts; the picker's DOM
    // does not. So when that table is available it IS the list — every row then
    // has a payout — and the DOM contributes nothing but the order it showed the
    // pairs in. A DOM row the broker's table doesn't list is dropped rather than
    // shown payout-less: it means the cached scan has gone stale, and a pair the
    // broker no longer offers cannot be traded anyway.
    var fromSocket = socketRealPairs();
    var seen = {}, out = [];
    if (fromSocket.length) {
      var bySocket = {};
      fromSocket.forEach(function (p) { bySocket[p.code] = p; });
      (cache.list || []).forEach(function (p) {
        if (p.otc || seen[p.code] || !bySocket[p.code]) { return; }
        seen[p.code] = 1;
        out.push(bySocket[p.code]);
      });
      fromSocket.forEach(function (p) {
        if (seen[p.code]) { return; }
        seen[p.code] = 1;
        out.push(p);
      });
    } else {
      (cache.list || []).forEach(function (p) {
        if (p.otc || p.closed || seen[p.code]) { return; }
        seen[p.code] = 1;
        out.push({ code: p.code, label: p.label });
      });
    }
    var current = cache.current ? cache.current.code : (socketAssets.current || null);
    return {
      mode: mode,
      source: out.length ? (fromSocket.length ? "socket" : "dom") : "none",
      current: current,
      list: out,
      ageMs: cache.scannedAt ? (Date.now() - cache.scannedAt) : null
    };
  }

  // Push an update the instant the charted symbol (or account mode) changes,
  // instead of making the popup wait for its next poll. Watches the compact
  // header component rather than the whole page, and debounces bursts of DOM
  // mutations into a single rescan.
  var lastPushed = { current: null, mode: null, size: -1 };
  var pushTimer = null;
  var pushForced = false;
  function schedulePush(force) {
    if (force) { pushForced = true; }
    if (pushTimer) { return; }
    pushTimer = setTimeout(function () {
      pushTimer = null;
      var forced = pushForced;
      pushForced = false;
      var data = liveAssets();
      var same = data.current === lastPushed.current && data.mode === lastPushed.mode &&
        data.list.length === lastPushed.size;
      if (same && !forced) { return; }
      lastPushed = { current: data.current, mode: data.mode, size: data.list.length };
      try { chrome.runtime.sendMessage({ action: "ASSET_UPDATE", payload: data }); } catch (e) {}
    }, 150);
  }
  function watchAssets() {
    // observe(null) THROWS, and this runs at load - a hundred lines above the
    // message listener, which then never registers and the whole content script
    // goes silent. The popup reads that as "Open your PocketOption tab", with no
    // clue that the extension is alive but deaf. Firefox reaches document_idle
    // before the SPA has a body more readily than Chrome does, so this is where
    // it bit. Wait for a target rather than assume one.
    var target = document.querySelector(".currencies-block") || document.body;
    if (!target) {
      setTimeout(watchAssets, 500);
      return;
    }
    var obs = new MutationObserver(function () { schedulePush(false); });
    obs.observe(target, { childList: true, subtree: true, characterData: true });
    // Page not hydrated yet (fell back to document.body) — once the real header
    // shows up, re-scope the observer to it so unrelated page churn (chart ticks
    // etc.) stops triggering scans.
    if (target === document.body) {
      var narrow = setInterval(function () {
        var el = document.querySelector(".currencies-block");
        if (!el) { return; }
        clearInterval(narrow);
        obs.disconnect();
        obs.observe(el, { childList: true, subtree: true, characterData: true });
      }, 2000);
    }
    schedulePush(false);
  }
  // Nothing at load may be allowed to take the message listener down with it: the
  // listener is what makes the extension answerable at all, and it registers far
  // below here.
  try { watchAssets(); }
  catch (e) { console.error("[SignalBots] PocketOption asset watcher failed to start:", e); }

  // Engine.IO v4 / Socket.IO v4 client over a raw WebSocket.

  // Normalise a server host into a full socket.io v4 websocket URL.
  function socketUrl(host) {
    var raw = String(host || "").trim();
    if (!/^[a-z]+:\/\//i.test(raw)) { raw = "wss://" + raw; }
    var u = new URL(raw);
    if (u.protocol === "http:") { u.protocol = "ws:"; }
    else if (u.protocol === "https:") { u.protocol = "wss:"; }
    if (!u.pathname || u.pathname === "/") { u.pathname = "/socket.io/"; }
    if (!u.searchParams.has("EIO")) { u.searchParams.set("EIO", "4"); }
    if (!u.searchParams.has("transport")) { u.searchParams.set("transport", "websocket"); }
    return u.toString();
  }

  // Race every advertised server; keep the first WebSocket to open, close the
  // rest. Resolves with the winning open socket, or null on total timeout.
  function raceServers(hosts, cb) {
    var urls = (hosts && hosts.length) ? hosts : [location.host];
    var settled = false, opened = [];
    var timer = setTimeout(function () { finish(null); }, 6000);
    function finish(win) {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      for (var i = 0; i < opened.length; i++) {
        if (opened[i] !== win) { try { opened[i].close(1000, "probe finished"); } catch (e) {} }
      }
      cb(win);
    }
    urls.forEach(function (h) {
      var ws;
      try { ws = new WebSocket(socketUrl(h)); } catch (e) { return; }
      opened.push(ws);
      ws.onopen = function () { finish(ws); };
      ws.onerror = function () {};
    });
    if (!opened.length) { finish(null); }
  }

  // Minimal EIO4/SIO4 framing on top of an already-open WebSocket.
  //
  // PocketOption sends its bulk payloads (the instrument table above all) as
  // Socket.IO BINARY attachment events: a text header `45<N>-["name",{...}]` in
  // which each `{_placeholder:true,num:i}` stands for one of the N binary frames
  // that follow. Frames therefore have to be decoded, kept in arrival order, and
  // reassembled — a reader that stringifies each frame and skips packet type 45
  // sees "[object Blob]" and drops the payload without a trace.
  var textDecoder = new TextDecoder();

  function PocketSocket(ws) {
    this.ws = ws;
    this.ready = false;         // namespace handshake complete
    this.handlers = {};
    this.queue = [];
    this.onReady = null;
    this.onClose = null;
    this.pendingBinary = null;
    var self = this;
    var chain = Promise.resolve();
    try { ws.binaryType = "arraybuffer"; } catch (e) {}
    ws.onmessage = function (ev) {
      chain = chain.then(function () { return frameText(ev.data); }).then(function (f) {
        if (f) { try { self._recv(f.text, f.binary); } catch (e2) {} }
      });
    };
    ws.onclose = function () { self.ready = false; if (self.onClose) { self.onClose(); } };
    ws.onerror = function () {};
  }

  // Normalise one WebSocket frame to { text, binary }, reading Blobs when the
  // browser hands them over instead of ArrayBuffers.
  function frameText(data) {
    if (typeof data === "string") { return { text: data, binary: false }; }
    if (data && typeof data.byteLength === "number") {
      var view = (typeof data.buffer !== "undefined") ? data : new Uint8Array(data);
      return { text: textDecoder.decode(view), binary: true };
    }
    if (data && typeof data.arrayBuffer === "function") {
      return data.arrayBuffer().then(function (buf) {
        return { text: textDecoder.decode(new Uint8Array(buf)), binary: true };
      }, function () { return null; });
    }
    return null;
  }

  function isPlaceholder(v) {
    return !!v && typeof v === "object" && v._placeholder === true && typeof v.num === "number";
  }

  function injectAttachments(template, parts) {
    if (isPlaceholder(template)) { return parts[template.num] != null ? parts[template.num] : null; }
    if (Array.isArray(template)) {
      return template.map(function (v) { return injectAttachments(v, parts); });
    }
    if (template && typeof template === "object") {
      var out = {};
      Object.keys(template).forEach(function (k) { out[k] = injectAttachments(template[k], parts); });
      return out;
    }
    return template;
  }

  function parseJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  // Events that fire many times a second (price ticks) or every few seconds
  // (balance echoes) are handled but never logged, so the console stays readable
  // for the ones that matter — order acks and rejections.
  var LOUD_EVENTS = { openOrder: 1, successopenOrder: 1, failopenOrder: 1, successcloseOrder: 1 };
  var QUIET_EVENTS = {
    updateStream: 1, updateHistoryNew: 1, TotalBalance: 1, successupdateBalance: 1,
    updateAssets: 1, loadHistoryPeriod: 1
  };

  PocketSocket.prototype._send = function (frame) {
    try { this.ws.send(frame); return true; } catch (e) { return false; }
  };
  PocketSocket.prototype._fire = function (name, args) {
    if (!QUIET_EVENTS[name]) {
      // Order acks are printed expanded: the broker's own timestamps on them are
      // the only proof of the expiry it actually used.
      if (LOUD_EVENTS[name]) {
        try { console.log("[SignalBots] PocketOption <-", name, JSON.stringify(args)); }
        catch (e) { console.log("[SignalBots] PocketOption <-", name, args); }
      } else {
        console.log("[SignalBots] PocketOption <-", name, args);
      }
    }
    var hs = this.handlers[name] || [];
    for (var j = 0; j < hs.length; j++) { try { hs[j].apply(null, args); } catch (e) {} }
  };
  PocketSocket.prototype._recv = function (data, isBinary) {
    if (isBinary) {                                          // binary attachment
      var p = this.pendingBinary;
      if (!p) { return; }
      p.parts.push(parseJson(data));
      if (p.parts.length < p.expected) { return; }
      this.pendingBinary = null;
      this._fire(p.name, [injectAttachments(p.template, p.parts)]);
      return;
    }
    if (data === "2") { this._send("3"); return; }          // engine ping -> pong
    if (data === "3" || data === "1") { return; }            // pong / close ack
    var head = data.charAt(0);
    if (head === "0") {                                       // engine open handshake
      this._send("40");                                      // socket.io connect (default ns)
      return;
    }
    if (data.indexOf("40") === 0) {                          // namespace connected
      this.ready = true;
      var q = this.queue; this.queue = [];
      for (var i = 0; i < q.length; i++) { this._send(q[i]); }
      if (this.onReady) { this.onReady(); }
      return;
    }
    if (data.indexOf("42") === 0) {                          // text event
      var arr = parseJson(data.slice(2));
      if (Array.isArray(arr) && arr.length && typeof arr[0] === "string") {
        this._fire(arr[0], arr.slice(1));
      }
      return;
    }
    if (data.indexOf("44") === 0) {                          // connect_error
      // Never swallow this: a rejected namespace connect is indistinguishable
      // from a healthy-but-silent socket unless it is surfaced.
      console.error("[SignalBots] PocketOption connect_error:", data.slice(2));
      return;
    }
    var m = /^45(\d+)-([\s\S]+)$/.exec(data);                // binary event header
    if (!m) { return; }
    var n = Number(m[1]);
    var header = parseJson(m[2]);
    if (!(n > 0) || !Array.isArray(header) || typeof header[0] !== "string") { return; }
    this.pendingBinary = {
      expected: n,
      parts: [],
      name: header[0],
      template: header.length > 1 ? header[1] : null
    };
  };
  PocketSocket.prototype.on = function (name, fn) {
    (this.handlers[name] = this.handlers[name] || []).push(fn);
  };
  PocketSocket.prototype.emit = function (name) {
    var args = Array.prototype.slice.call(arguments, 1);
    var frame = "42" + JSON.stringify([name].concat(args));
    if (this.ready) { return this._send(frame); }
    this.queue.push(frame);
    return true;
  };
  PocketSocket.prototype.close = function () {
    try { this.ws.close(1000, "client closed"); } catch (e) {}
  };

  // One emit for the whole engine, over whichever transport is live: our own
  // socket when it authorised, otherwise the page's own through the tap.
  function emit(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (link.sock && link.authed && !page.via) {
      return link.sock.emit.apply(link.sock, [name].concat(args));
    }
    if (page.socket) {
      try {
        window.postMessage({
          __sb: "SB_PO_TAP", req: "EMIT",
          frame: "42" + JSON.stringify([name].concat(args))
        }, "*");
        return true;
      } catch (e) { return false; }
    }
    return false;
  }

  // Run on the page's socket. Deliberately NOT re-authorising: it is already the
  // user's authorised session, and a second `auth` over it would disturb the
  // terminal they are looking at. The account it is on is the account the PAGE is
  // on, which is why an order for the other one is refused rather than switched.
  function adoptPageSocket(creds) {
    page.via = true;
    link.authed = true;
    link.authConfirmed = true;
    link.mode = (creds && creds.isDemo) ? "demo" : "real";
    if (creds && isFinite(creds.seedDemo)) { link.demo = creds.seedDemo; }
    if (creds && isFinite(creds.seedReal)) { link.real = creds.seedReal; }
    console.log("[SignalBots] PocketOption own socket did not connect — running on the "
      + "page's own socket instead (account: " + link.mode + ").");
    chrome.runtime.sendMessage({ action: "REGISTER_ACTIVE_TAB" });
    pushBalance();
    schedulePush(true);
  }

  // High-level link: connect + auth, balances, orders, mode switch.

  function pushBalance() {
    chrome.runtime.sendMessage({
      action: "BALANCE_UPDATE",
      payload: {
        demo: isFinite(link.demo) ? link.demo : null,
        real: isFinite(link.real) ? link.real : null
      }
    });
  }

  var pingTimer = null;
  function startPing(sock) {
    stopPing();
    pingTimer = setInterval(function () {
      if (link.sock === sock) { sock.emit("ps"); } else { stopPing(); }
    }, 50000);
  }
  function stopPing() { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } }

  // `unconfirmed` marks the one outcome that is neither success nor rejection:
  // we sent the order and never heard back, so it may be live on the account.
  // The popup must not treat it as a rejection — see openTrade's timeout.
  function settleOrder(rid, ok, err, unconfirmed, durationMismatch) {
    var p = pending[rid];
    if (!p) { return; }
    delete pending[rid];
    clearTimeout(p.timer);
    // An expiry the broker will not take is a settings problem, not a broker
    // problem, so it is reported as its own outcome: the popup ends the run on
    // the first one with an explanation instead of counting it toward the
    // three-strikes guard and sending two more orders that cannot be accepted.
    var expiry = !ok && isExpiryError(err);
    if (expiry) {
      badExpiry[expiryKey(p.asset, p.wantedSeconds)] = true;
      console.log("[SignalBots] PocketOption refuses a " + p.wantedSeconds + "s expiry on "
        + p.asset + " — remembering it; later orders for that pair stop here.");
    }
    p.resolve({
      success: ok,
      error: err || undefined,
      unconfirmed: !!unconfirmed,
      durationMismatch: durationMismatch || undefined,
      expiryRejected: expiry || undefined,
      asset: p.asset,
      seconds: p.wantedSeconds,
      // When this position closes, on OUR clock — see ackCloseAt. The popup
      // counts it down and paces the run by it, so what it shows is what the
      // broker's own terminal shows.
      closesAt: p.closesAt || undefined
    });
  }

  // How long the broker ACTUALLY opened the position for, from its own ack. The
  // field names vary across PocketOption builds, so every plausible pair is
  // tried, and both second- and millisecond-epoch stamps are accepted.
  function num(v) { return (typeof v === "number" && isFinite(v)) ? v : null; }

  // The moment the broker will close this position, expressed on OUR clock.
  //
  // Its stamps are absolute and on ITS clock, so using closeTimestamp directly
  // would put the whole countdown out by however far the machine's clock has
  // drifted. Mapping them through the instant the ack arrived cancels that:
  // openTimestamp (+ openMs, which the ack carries) is where the broker's clock
  // stood when it opened the position, Date.now() is where ours stood a network
  // hop later, and the difference between them carries closeTimestamp across.
  // Left over is that one hop — tens of milliseconds against a countdown read in
  // whole seconds.
  function ackCloseAt(o) {
    var opened = num(o.openTimestamp) || num(o.open_time);
    var closes = num(o.closeTimestamp) || num(o.close_time)
      || num(o.expirationTimestamp) || num(o.expiration);
    if (!opened || !closes || closes <= opened) { return null; }
    if (opened > 1e11) { opened = opened / 1000; closes = closes / 1000; }  // ms stamps
    var openedMs = opened * 1000 + (num(o.openMs) || 0);
    return Math.round(closes * 1000 + (Date.now() - openedMs));
  }

  function ackDurationSeconds(o) {
    var opened = num(o.openTimestamp) || num(o.openTime) || num(o.open_time);
    var closes = num(o.closeTimestamp) || num(o.closeTime) || num(o.close_time)
      || num(o.expirationTimestamp) || num(o.expiration);
    if (!opened || !closes || closes <= opened) { return null; }
    var d = closes - opened;
    if (d > 100000) { d = d / 1000; }        // millisecond stamps
    return Math.round(d);
  }

  // Accept an ack from either connection. Duplicates are free: settleOrder is a
  // no-op once the order has been resolved, so whichever socket answers first
  // wins and the second copy costs nothing.
  //
  // A confirmed order is also CHECKED: PocketOption has been observed opening a
  // 10-second request as a 1-minute position, intermittently. Trusting the ack
  // because it says "success" is how a trade runs for six times the length the
  // user chose, so the broker's own expiry is compared against the one requested
  // and a mismatch is reported rather than swallowed.
  function acceptOrderAck(o, ok, source) {
    if (!o || typeof o !== "object") { return; }
    var rid = (o.requestId === 0 || o.requestId) ? String(o.requestId) : null;
    var reason = ok ? null : (o.error ? String(o.error) : "rejected by PocketOption");
    if (rid === null || !pending[rid]) {
      if (rid === null && !ok) { settleUnattributed(reason, o); }
      return;
    }
    if (!ok) {
      console.log("[SignalBots] PocketOption order rejected via " + source
        + " (requestId " + rid + "): " + reason);
      settleOrder(rid, false, reason);
      return;
    }
    var wanted = pending[rid].wantedSeconds;
    var actual = ackDurationSeconds(o);
    pending[rid].closesAt = ackCloseAt(o);
    var window_ = (o.openTime && o.closeTime) ? (" [" + o.openTime + " -> " + o.closeTime + "]") : "";
    console.log("[SignalBots] PocketOption order confirmed via " + source
      + " (requestId " + rid + ", requested " + wanted + "s, broker "
      + (actual === null ? "did not state a duration" : actual + "s") + ")" + window_);
    // Two seconds of slack absorbs the broker rounding to its own clock tick.
    if (wanted && actual !== null && Math.abs(actual - wanted) > 2) {
      settleOrder(rid, true, null, false, { requested: wanted, actual: actual });
      return;
    }
    settleOrder(rid, true, null);
  }

  // A rejection that names no requestId is matched on the order's own shape
  // instead: PocketOption omits requestId on `IncorrectExpTime` but still echoes
  // the asset and the stake, and that pair identifies which of our orders it is
  // answering. Falling back to "settle it if exactly one order is in flight" was
  // wrong in both directions — the page tap forwards rejections of trades the
  // USER placed by hand on the terminal too, and one of those would have failed
  // our unrelated order.
  //
  // The same rejection also arrives more than once (our socket and the page's,
  // and the broker repeats it), so a copy landing after the order is settled is
  // normal rather than a fault; it is dropped quietly instead of printing a line
  // per copy, which is what filled the console during one failed trade.
  var lastUnmatched = { key: "", at: 0 };
  function settleUnattributed(reason, o) {
    var asset = o && o.asset ? String(o.asset).toUpperCase() : null;
    var amount = (o && typeof o.amount === "number") ? o.amount : null;
    var rids = Object.keys(pending);
    for (var i = 0; i < rids.length; i++) {
      var p = pending[rids[i]];
      if (asset && p.asset !== asset) { continue; }
      if (amount !== null && p.amount !== amount) { continue; }
      settleOrder(rids[i], false, reason);
      return;
    }
    // Nothing of ours matches: either the order is already settled by an earlier
    // copy of this same rejection, or the broker is answering a trade the user
    // placed themselves. Neither is ours to act on — say it once per rejection.
    var key = (asset || "?") + "|" + reason, now = Date.now();
    if (key === lastUnmatched.key && (now - lastUnmatched.at) < 5000) { return; }
    lastUnmatched.key = key; lastUnmatched.at = now;
    console.log("[SignalBots] PocketOption rejection matches no order still in flight"
      + (asset ? " (" + asset + ")" : "") + " — already settled by an earlier copy, or a "
      + "trade placed on the terminal by hand:", reason);
  }

  // Wire the balance + order-ack listeners onto a fresh socket, then authorise.
  function wireAndAuth(sock, creds) {
    // Seed both balances from the page so the popup isn't blank pre-stream.
    if (isFinite(creds.seedDemo)) { link.demo = creds.seedDemo; }
    if (isFinite(creds.seedReal)) { link.real = creds.seedReal; }

    function onBalance(b) {
      if (!b || typeof b.balance !== "number" || !isFinite(b.balance)) { return; }
      if (b.isDemo === 1) { link.demo = b.balance; }
      else if (b.isDemo === 0) { link.real = b.balance; }
      pushBalance();
    }
    sock.on("TotalBalance", onBalance);
    sock.on("successupdateBalance", onBalance);

    // Order acks. The broker echoes openOrder on success and failopenOrder on
    // rejection, both carrying the requestId we sent. The identical ack heard on
    // the PAGE's socket settles the same order (see the tap listener above), so
    // whichever connection the broker answers on, the order is resolved.
    sock.on("openOrder", function (o) { acceptOrderAck(o, true, "our socket"); });
    sock.on("successopenOrder", function (o) { acceptOrderAck(o, true, "our socket"); });
    sock.on("failopenOrder", function (o) { acceptOrderAck(o, false, "our socket"); });

    // The broker's instrument table. It arrives unprompted after a successful
    // auth, as a binary attachment event — see the frame reader above.
    sock.on("updateAssets", function (rows) {
      if (Array.isArray(rows)) { adoptSocketAssets(slimAssetRows(rows)); }
    });

    // Proof that the session was accepted. Without it a rejected auth looks
    // exactly like a healthy connection that the broker happens to be quiet on:
    // no balances, no instrument table, and orders that time out with "no
    // confirmation". The three loads mirror what PocketOption's own client asks
    // for right after auth, which is what makes the broker start pushing.
    sock.on("successauth", function () {
      link.authConfirmed = true;
      console.log("[SignalBots] PocketOption auth confirmed (uid " + creds.uid + ")");
      sock.emit("indicator/load");
      sock.emit("favorite/load");
      sock.emit("price-alert/load");
    });

    sock.emit("auth", {
      isDemo: creds.isDemo ? 1 : 0,
      isFastHistory: true,
      isOptimized: true,
      platform: creds.platform,
      session: creds.session,
      uid: creds.uid
    });
    link.authed = true;
    link.authConfirmed = false;
    // A silent auth is the single most misleading failure mode here, so say so
    // rather than leaving the popup to report a healthy-looking link.
    setTimeout(function () {
      if (link.sock === sock && !link.authConfirmed) {
        console.log("[SignalBots] PocketOption never sent successauth — the session token " +
          "was likely rejected. Reload the PocketOption tab.");
      }
    }, 10000);
    link.mode = creds.isDemo ? "demo" : "real";
    pushBalance();
    // Application-level keepalive PocketOption expects post-auth.
    startPing(sock);
  }

  // Connect to the broker socket and authorise with `creds`. Idempotent: a live,
  // matching-mode link is reused; concurrent callers share one in-flight connect.
  function connect(creds) {
    if (!creds) { return Promise.resolve(false); }
    var wantMode = creds.isDemo ? "demo" : "real";
    if (link.authed && link.mode === wantMode && (page.via || link.sock)) {
      return Promise.resolve(true);
    }
    if (link.connecting) { return link.connecting; }
    link.creds = creds;
    link.connecting = new Promise(function (resolve) {
      raceServers(creds.serverUrls, function (ws) {
        if (!ws) {
          link.connecting = null;
          if (page.socket) { adoptPageSocket(creds); resolve(true); return; }
          console.error("[SignalBots] PocketOption could not reach any of its "
            + (creds.serverUrls || []).length + " advertised servers, and the page's own "
            + "socket was never seen — is the tab still on a PocketOption page?");
          resolve(false);
          return;
        }
        var sock = new PocketSocket(ws);
        // Tear down any previous socket before adopting this one.
        if (link.sock && link.sock !== sock) { try { link.sock.close(); } catch (e) {} }
        link.sock = sock;
        link.authed = false;
        sock.onClose = function () {
          if (link.sock === sock) { link.authed = false; }
        };
        var settled = false;
        function done(v) { if (settled) { return; } settled = true; link.connecting = null; resolve(v); }
        sock.onReady = function () {
          wireAndAuth(sock, creds);
          chrome.runtime.sendMessage({ action: "REGISTER_ACTIVE_TAB" });
          done(true);
        };
        // If the socket.io handshake never completes, release the flag.
        setTimeout(function () { done(link.authed); }, 8000);
      });
    });
    return link.connecting;
  }

  // Fetch the broker's cabinet page for `mode` so the site re-keys the session,
  // then parse AppData out of the response. Needed because demo and real carry
  // different session tokens.
  function rekey(mode, siteUrl) {
    var base = siteUrl || (location.origin + "/");
    if (base.charAt(base.length - 1) !== "/") { base += "/"; }
    var path = (mode === "demo") ? "cabinet/demo-quick-high-low/" : "cabinet/";
    return fetch(base + path, { credentials: "include" })
      .then(function (r) { return r.text(); })
      .then(function (html) { return deriveCreds(extractAppData(html)); })
      .catch(function () { return null; });
  }

  // Switch the authorised account. If the page is already in the target mode we
  // just (re)connect; otherwise re-key via the cabinet page first.
  function switchMode(mode) {
    var want = (mode === "real") ? "real" : "demo";
    var here = currentCreds();
    var haveIt = here && ((want === "demo") === !!here.isDemo);
    stopPing();
    if (link.sock) { try { link.sock.close(); } catch (e) {} link.sock = null; link.authed = false; }
    var get = haveIt ? Promise.resolve(here) : rekey(want, here && here.siteUrl);
    return get.then(function (creds) {
      if (!creds) { return { success: false, error: "Couldn't switch — reload the PocketOption tab." }; }
      return connect(creds).then(function (ok) {
        return ok
          ? { success: true }
          : { success: false, error: "Couldn't reach PocketOption after switching." };
      });
    });
  }

  // Authorise the link for the account THIS ORDER names, not for whichever one the
  // socket happens to be sitting on.
  //
  // These drift, and only ever bite on real. The order's isDemo comes from the
  // popup's Demo/Real switch; the socket's account came from whatever credentials
  // it last connected with — and background.js re-seeds its idea of the mode from
  // the PAGE whenever the MV3 service worker restarts, which it does constantly.
  // So a popup set to Real could hand a real order to a socket still authorised
  // for demo. PocketOption answers that with nothing at all: no ack, no
  // rejection, no position — the "it didn't confirm on my real account" report.
  // Demo never showed it because demo-on-demo always happens to match.
  //
  // The opposite drift is worse than a missing confirmation, so the caller checks
  // the result again before it emits: a popup on Demo must never reach a socket
  // authorised for real and open a live-money position.
  function ensureOrderAccount(isDemo) {
    var want = isDemo ? "demo" : "real";
    // Riding the page's socket, the account is whichever one the TERMINAL is on:
    // switching it means re-keying the session, which would pull the user's own
    // tab onto the other account under them. So the page's account is read, never
    // changed, and an order for the other one is refused by the caller with the
    // terminal named.
    if (page.via) {
      var here = currentCreds();
      link.mode = (here && here.isDemo) ? "demo" : "real";
      if (link.mode !== want) {
        console.log("[SignalBots] PocketOption order wants the " + want + " account but the "
          + "page is on " + link.mode + " — switch it on the terminal.");
      }
      return Promise.resolve(link.mode === want);
    }
    if (link.sock && link.authed && link.mode === want) { return Promise.resolve(true); }
    console.log("[SignalBots] PocketOption order wants the " + want + " account, socket is on "
      + (link.mode || "none") + " — re-authorising before it is sent.");
    return switchMode(want).then(function (r) { return !!(r && r.success); });
  }

  // Place one CALL/PUT. Resolves on the broker ack, or fails after a timeout with
  // an explicit "no confirmation" — a real-money order is never assumed placed.
  function openTrade(p) {
    if (p.direction !== "call" && p.direction !== "put") {
      return Promise.resolve({ success: false, error: "invalid trade direction" });
    }
    if (!isFinite(p.amount) || Number(p.amount) <= 0) {
      return Promise.resolve({ success: false, error: "invalid stake amount" });
    }
    // Already refused for this pair at this expiry — don't ask again. Sending it
    // is not free: every refusal is a round trip the run waits on, and three of
    // them in a row is what stopped Auto-Trade with a message about the account
    // when the account was fine.
    var wanted = Number(p.timeframe) || null;
    if (wanted && badExpiry[expiryKey(p.asset, wanted)]) {
      return Promise.resolve({
        success: false, error: EXPIRY_REJECTED, expiryRejected: true,
        asset: String(p.asset).toUpperCase(), seconds: wanted
      });
    }
    var sig = orderSig(p), now = Date.now(), prev = recent[sig];
    pruneRecent(now);
    if (prev && (prev.pending || (now - prev.ts) < dedupWindow(p))) {
      console.log("[SignalBots] PocketOption duplicate order suppressed (" + sig + ")");
      return prev.promise;
    }
    var entry = { ts: now, pending: true, promise: null };
    recent[sig] = entry;
    var wantMode = p.isDemo ? "demo" : "real";
    entry.promise = ensureOrderAccount(p.isDemo).then(function (ok) {
      if (!ok || (!link.sock && !page.via)) {
        return { success: false, error: "couldn't reach your " + wantMode + " account" };
      }
      // Checked again after the switch, not just before it: an order carrying the
      // wrong account is the one failure here that can cost real money, so it is
      // refused outright rather than sent and reported on.
      if (link.mode !== wantMode) {
        return {
          success: false,
          error: "PocketOption is still on the " + link.mode + " account — switch to "
            + wantMode + " on the terminal, then start again"
        };
      }
      var rid = ++reqSeq;
      var order = {
        asset: p.asset,
        amount: Number(p.amount),
        action: p.direction,
        isDemo: p.isDemo ? 1 : 0,
        requestId: rid,
        optionType: 100,
        time: p.timeframe
      };
      console.log("[SignalBots] PocketOption openOrder ->", JSON.stringify(order));
      return new Promise(function (resolve) {
        pending[rid] = {
          resolve: resolve,
          wantedSeconds: wanted,
          // Kept so a rejection that names no requestId can still be matched to
          // the order it answers — see settleUnattributed.
          asset: String(p.asset).toUpperCase(),
          amount: Number(p.amount),
          // Neither confirmed nor rejected: the order left our socket and the
          // broker said nothing. It may be live on the account, so it is flagged
          // `unconfirmed` and the popup stops the run instead of counting it as a
          // rejection and trading the next candle on top of an unknown position.
          timer: setTimeout(function () {
            console.log("[SignalBots] PocketOption never acked order " + rid
              + " — it may still have been placed.");
            settleOrder(rid, false, "no confirmation from PocketOption — check your open positions", true);
          }, 12000)
        };
        if (!emit("openOrder", order)) {
          settleOrder(rid, false, "socket not connected");
        }
      });
    }).then(function (res) {
      entry.pending = false; entry.ts = Date.now(); return res;
    }, function (err) {
      entry.pending = false; entry.ts = Date.now();
      return { success: false, error: String((err && err.message) || err) };
    });
    return entry.promise;
  }

  // Chrome-message contract (driven by the shared background.js).

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.action) { return false; }

    if (msg.action === "GET_CREDENTIALS") {
      // Never let an unexpected AppData shape throw here: an uncaught exception
      // closes the message channel with no response, and background.js's retry
      // just re-triggers the same throw forever (the id/balance never appear).
      try {
        var c = currentCreds();
        if (!c) { sendResponse({ success: false, error: "not logged in to PocketOption" }); return true; }
        sendResponse({ success: true, data: c });
      } catch (e) {
        console.error("[SignalBots] PocketOption GET_CREDENTIALS failed:", e);
        sendResponse({ success: false, error: "credential read error: " + ((e && e.message) || e) });
      }
      return true;
    }

    if (msg.action === "CONNECT_WS") {
      var creds = msg.payload || currentCreds();
      connect(creds).then(function (ok) {
        sendResponse({ success: !!ok, error: ok ? undefined : "could not authorise PocketOption socket" });
      });
      return true;
    }

    if (msg.action === "ACCOUNT_MODE_UPDATE") {
      var mode = (msg.payload && msg.payload.mode) === "real" ? "real" : "demo";
      switchMode(mode).then(function (r) { sendResponse(r); });
      return true;
    }

    if (msg.action === "OPEN_TRADE") {
      openTrade(msg.payload || {}).then(function (r) { sendResponse(r); });
      return true;
    }

    if (msg.action === "GET_ASSETS") {
      try { sendResponse({ success: true, data: liveAssets() }); }
      catch (e) {
        console.error("[SignalBots] PocketOption GET_ASSETS failed:", e);
        sendResponse({ success: false, error: String((e && e.message) || e) });
      }
      return true;
    }

    return false;
  });

  // Announce the tab so the worker's ensureBroker() can adopt it immediately.
  try { chrome.runtime.sendMessage({ action: "REGISTER_ACTIVE_TAB" }); } catch (e) {}
})();
