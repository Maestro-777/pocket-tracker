/*
 * SignalBots binary-signal extension — background service worker.
 *
 * Owns the only network call: the cross-origin fetch to the SignalBots signal
 * endpoint (host_permissions: signalbots.ai), which bypasses page CORS and
 * forwards the user's signalbots.ai cookies so a licensed visitor unlocks
 * Premium timeframes server-side. It adds nothing to the read — it relays the
 * selection (broker, market mode, pair, timeframe) and passes the JSON back.
 * All signal logic stays server-side (core.services.binary_signal).
 */
// Chrome runs this file as a service worker, where importScripts is the only way
// to pull config.js in. Firefox has no MV3 service worker — the background is an
// event page, which loads config.js from the manifest's background.scripts and has
// no importScripts at all. Calling it unguarded is a ReferenceError that takes the
// whole worker down on Firefox, so this file stays byte-identical across both
// packages and asks which one it is in.
if (typeof importScripts === "function") { importScripts("config.js"); }

var CFG = self.CB_CONFIG;

// Broker display name + the socket-engine content-script filename, both from the
// per-broker config so this worker is byte-identical across every OTC bot
// (Quotex / PocketOption / Olymp / IQ). BK is used only in user-facing messages.
var BK = (CFG.BROKER && CFG.BROKER.label) || "your broker";
var SOCKET_FILE = CFG.SOCKET_FILE || "broker-socket.js";

function buildUrl(req) {
  var params = new URLSearchParams();
  params.set("broker", req.broker);
  params.set("mode", req.mode);
  params.set("pair", req.pair);
  params.set("tf", req.tf);
  params.set("salt", String(req.salt || 0));
  if (req.salt > 0 && req.prev) { params.set("prev", req.prev); }
  // License key (SB-XXXXXXXXXX) unlocks Premium timeframes server-side without a
  // site session — the signal endpoint resolves access by key + item.
  if (req.key) { params.set("key", req.key); }
  if (req.item) { params.set("item", req.item); }
  // The logged-in broker account's own id (content.js reads it from the broker
  // page) — when the license pins a customer id for this broker, the server
  // requires this to match (licensing.services.key_broker_uid_matches).
  if (req.uid) { params.set("uid", req.uid); }
  return CFG.SIGNAL_URL + "?" + params.toString();
}

function fetchSignal(req, sendResponse) {
  fetch(buildUrl(req), {
    method: "GET",
    credentials: "include",
    headers: { "Accept": "application/json" }
  })
    .then(function (resp) {
      return resp.json().catch(function () { return null; }).then(function (data) {
        sendResponse({ ok: resp.ok, status: resp.status, data: data });
      });
    })
    .catch(function (err) {
      sendResponse({ ok: false, status: 0, error: String((err && err.message) || err) });
    });
}

// Validate a license against the site's own endpoint. Sends the signalbots.ai
// cookies (a logged-in account) and/or a bot unlock token (?lt=), and returns
// the server's authoritative { licensed, brokers } verdict. No local trust — a
// key/login that the Licensing system doesn't recognise comes back licensed:false.
function checkLicense(req, sendResponse) {
  var params = new URLSearchParams();
  if (req && req.key) { params.set("key", req.key); }
  if (req && req.lt) { params.set("lt", req.lt); }
  if (req && req.item) { params.set("item", req.item); }
  // Asking about a specific broker also returns broker_uid — the customer id
  // pinned to this license+broker, so the popup can compare it against the id
  // it reads from the logged-in broker page (see each bot's socket engine).
  if (req && req.broker) { params.set("broker", req.broker); }
  var qs = params.toString();
  var url = CFG.LICENSE_URL + (qs ? "?" + qs : "");
  fetch(url, {
    method: "GET",
    credentials: "include",
    headers: { "Accept": "application/json" }
  })
    .then(function (resp) {
      return resp.json().catch(function () { return null; }).then(function (data) {
        sendResponse({ ok: resp.ok, status: resp.status, data: data });
      });
    })
    .catch(function (err) {
      sendResponse({ ok: false, status: 0, error: String((err && err.message) || err) });
    });
}

// Broker link (OTC bot only). Every one of these brokers exposes account identity,
// live balances, account switching and trade placement ONLY through its own
// WebSocket — the terminals are React-rendered and unscrapable — so each bot ships
// a socket engine as a content script on the broker tab (CFG.SOCKET_FILE). Whatever
// the broker's wire protocol, every engine answers the same contract: it reads the
// logged-in session off the page, authorises, streams both demo+real balances,
// switches the active account, reports the live instrument list, and places CALL/PUT
// orders. This worker owns that link and exposes it to the popup as
// CB_BROKER_STATE / CB_SET_ACCOUNT / CB_TRADE.
var broker = {
  tabId: null, connected: false, connecting: false, userId: null, mode: null,
  demo: NaN, real: NaN, assets: null,
  // Not every broker's engine reports a live instrument list — the ones built on a
  // reused third-party bundle answer nothing to GET_ASSETS. An unanswered message
  // closes the channel, which sendToSocket reads as "the script isn't there" and
  // re-injects it, once per poll, forever. So the first silence is remembered and
  // the question stops being asked; the popup falls back to config.js STATIC_PAIRS,
  // which is exactly what those builds shipped with anyway. Cleared with the tab.
  noAssets: false
};

function findBrokerTab(cb) {
  chrome.tabs.query({}, function (tabs) {
    var hosts = CFG.BROKER_HOSTS || [];
    var tab = (tabs || []).filter(function (t) {
      return t.url && hosts.some(function (h) { return t.url.indexOf(h) !== -1; });
    })[0];
    cb(tab || null);
  });
}

// Message the socket content script; if it isn't there (a broker tab that predates
// the install/update, so no auto-injection), inject it on demand and retry once.
function sendToSocket(tabId, message, cb) {
  chrome.tabs.sendMessage(tabId, message, function (resp) {
    if (!chrome.runtime.lastError && resp !== undefined) { cb(resp); return; }
    if (!chrome.scripting || !chrome.scripting.executeScript) { cb(null); return; }
    chrome.scripting.executeScript({ target: { tabId: tabId }, files: [SOCKET_FILE] }, function () {
      if (chrome.runtime.lastError) { cb(null); return; }
      chrome.tabs.sendMessage(tabId, message, function (resp2) { cb(chrome.runtime.lastError ? null : resp2); });
    });
  });
}

// Ensure the socket is authorised for the current broker tab (idempotent).
function ensureBroker(cb) {
  findBrokerTab(function (tab) {
    if (!tab) {
      // Say which hosts were looked for. "Open your tab" on a tab that IS open
      // means the URL did not match, and the only way to see that is to print it.
      console.warn("[SignalBots] no " + BK + " tab found among the hosts this build knows: "
        + (CFG.BROKER_HOSTS || []).join(", "));
      broker.tabId = null; broker.connected = false; cb(false); return;
    }
    if (broker.tabId !== tab.id) {
      broker.connected = false; broker.userId = null; broker.assets = null; broker.noAssets = false;
    }
    broker.tabId = tab.id;
    if (broker.connected) { cb(true); return; }
    // A connect already in flight is answered by JOINING it, never by reporting
    // "no broker". Telling the caller false while the socket is seconds from
    // being up is how a live auto-trade run died with "Open your <broker> tab" —
    // on a tab that was open, on a popup whose own header said "On <broker>",
    // because a state poll had started the attempt a moment earlier and the trade
    // arrived inside its window. The connect is idempotent; the wait is not a
    // failure.
    if (broker.connecting) { (broker.waiters = broker.waiters || []).push(cb); return; }
    broker.connecting = true;
    broker.waiters = [];
    // Never get stuck in "connecting": if CONNECT_WS never resolves (e.g. auth
    // never completes), release the flag so the next poll can retry.
    var settled = false;
    function done(v) {
      if (settled) { return; }
      settled = true;
      broker.connecting = false;
      var waiting = broker.waiters || [];
      broker.waiters = [];
      cb(v);
      waiting.forEach(function (w) { try { w(v); } catch (e) {} });
    }
    setTimeout(function () { done(broker.connected); }, 8000);
    sendToSocket(tab.id, { action: "GET_CREDENTIALS" }, function (res) {
      if (!res || !res.success || !res.data) { done(false); return; }
      broker.userId = res.data.userId != null ? String(res.data.userId) : null;
      if (broker.mode == null) { broker.mode = res.data.isDemo ? "demo" : "real"; }
      sendToSocket(tab.id, { action: "CONNECT_WS", payload: res.data }, function (c) {
        broker.connected = !!(c && c.success);
        done(broker.connected);
      });
    });
  });
}

// A socket-level failure (not a real trade rejection) — the WebSocket dropped
// since we last cached broker.connected (service-worker sleep, idle timeout, a
// tab reload). NOT the same thing as a license/account mismatch.
// "5 sec" / "1 min" / "4 hour" from a raw expiry in seconds, for messages that
// have to name the timeframe the user picked rather than a bare number.
function durationWord(seconds) {
  var n = Number(seconds) || 0;
  if (!n) { return "zero-length"; }
  if (n < 60) { return n + " sec"; }
  if (n < 3600) { return Math.round(n / 60) + " min"; }
  return Math.round(n / 3600) + " hour";
}

function isDeadSocket(r) {
  return !r || (r.success === false && /not connected|not authorized|disconnected|no response/i.test(String(r.error || "")));
}
// Send an action to the socket; if it comes back as a dropped-socket failure,
// force one reconnect and retry — so a stale connection self-heals instead of
// surfacing "Not connected" to the user.
function brokerAction(message, cb) {
  ensureBroker(function (ok) {
    if (!ok || broker.tabId == null) { cb(null); return; }
    sendToSocket(broker.tabId, message, function (r) {
      if (!isDeadSocket(r)) { cb(r); return; }
      broker.connected = false;
      ensureBroker(function (ok2) {
        if (!ok2 || broker.tabId == null) { cb(r); return; }
        sendToSocket(broker.tabId, message, function (r2) { cb(r2 || r); });
      });
    });
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) { return false; }
  if (msg.type === "CB_GET_SIGNAL") {
    fetchSignal(msg.payload || {}, sendResponse);
    return true;
  }
  if (msg.type === "CB_CHECK_LICENSE") {
    checkLicense(msg.payload || {}, sendResponse);
    return true;
  }
  // Balance stream + auth ack from the socket content script.
  if (msg.action === "BALANCE_UPDATE" && msg.payload) {
    broker.demo = parseFloat(msg.payload.demo);
    broker.real = parseFloat(msg.payload.real);
    return false;
  }
  if (msg.action === "REGISTER_ACTIVE_TAB") { broker.connected = true; return false; }
  // Instant symbol-change push from the socket content script (engines that read
  // only). Cached here so a popup that opens cold still gets the latest read
  // right away; the popup also listens for this message directly for the
  // already-open case, so the pair chips update with no poll delay.
  if (msg.action === "ASSET_UPDATE" && msg.payload) {
    broker.assets = msg.payload;
    return false;
  }
  // Popup asks for the live broker state (connection, id, both balances, mode,
  // and — where the engine reads it — the live OTC pair list off the page).
  if (msg.type === "CB_BROKER_STATE") {
    ensureBroker(function () {
      function respond(assets) {
        sendResponse({
          ok: true,
          tabOpen: broker.tabId != null,
          connected: broker.connected,
          userId: broker.userId,
          mode: broker.mode,
          demo: isFinite(broker.demo) ? broker.demo : null,
          real: isFinite(broker.real) ? broker.real : null,
          assets: assets
        });
      }
      if (broker.tabId == null || broker.noAssets) { respond(broker.assets || null); return; }
      sendToSocket(broker.tabId, { action: "GET_ASSETS" }, function (r) {
        if (r == null) { broker.noAssets = true; }
        respond((r && r.success) ? r.data : (broker.assets || null));
      });
    });
    return true;
  }
  if (msg.type === "CB_SET_ACCOUNT") {
    var mode = msg.account === "real" ? "real" : "demo";
    broker.mode = mode;
    brokerAction({ action: "ACCOUNT_MODE_UPDATE", payload: { mode: mode } }, function (r) {
      if (r == null) { sendResponse({ ok: false, message: "Open your " + BK + " tab first, then try again." }); return; }
      var ok2 = !!(r && r.success);
      sendResponse({ ok: ok2, message: ok2 ? ("Switched to your " + (mode === "real" ? "Real" : "Demo") + " account.") : ("Couldn't switch account — reload the " + BK + " tab.") });
    });
    return true;
  }
  if (msg.type === "CB_TRADE") {
    var p = msg.payload || {};
    brokerAction({
      action: "OPEN_TRADE",
      payload: {
        asset: p.asset, amount: p.amount, timeframe: p.timeframe,
        direction: p.direction, isDemo: p.isDemo, clientId: p.clientId
      }
    }, function (r) {
      if (r == null) { sendResponse({ ok: false, message: "Open your " + BK + " tab to auto-trade." }); return; }
      var ok2 = !!(r && r.success);
      var word = (p.direction === "call" ? "CALL" : "PUT");
      // `unconfirmed` is neither placed nor rejected — the order left for the
      // broker and nothing came back, so it may be live. It is passed through
      // rather than folded into "failed", because the popup must not count it as
      // a rejection or trade the next candle on top of an unknown position.
      // The broker confirmed the order but opened it for a different length than
      // asked. That is a live position the user did not choose the duration of,
      // so it is surfaced as a failure of the run rather than a green tick.
      if (r && r.durationMismatch) {
        var dm = r.durationMismatch;
        sendResponse({
          ok: false, durationMismatch: true,
          message: word + " opened for " + dm.actual + "s, not the " + dm.requested
            + "s you chose — " + BK + " overrode the expiry. Auto-Trade stopped."
        });
        return;
      }
      // The broker refused the EXPIRY, not the trade: it opens nothing and will
      // answer the same way every time, so this is reported as its own outcome
      // with the fix in it rather than as a bare "Trade failed: IncorrectExpTime".
      // PocketOption's sub-minute expiries are an OTC-asset feature; its
      // real-market pairs — the ones this build trades — start at one minute.
      if (r && r.expiryRejected) {
        var secs = Number(r.seconds) || 0;
        var on = r.asset ? " on " + r.asset : "";
        sendResponse({
          ok: false, expiryRejected: true,
          message: BK + " won't open a " + durationWord(secs) + " trade" + on
            + (secs && secs < 60
              ? " — sub-minute expiries are OTC-only there, and this bot trades the real market. Pick 1 min or longer."
              : " — that expiry isn't offered for this pair. Pick a different timeframe.")
        });
        return;
      }
      if (r && r.unconfirmed) {
        sendResponse({
          ok: false, unconfirmed: true,
          message: word + " sent to " + BK + " but not confirmed — check your open positions before trading again."
        });
        return;
      }
      sendResponse({
        ok: ok2,
        // The broker's own close moment for the position just opened, on the
        // popup's clock. It counts THIS down instead of counting to the next
        // candle, and waits for it before reading again.
        closesAt: (ok2 && r && r.closesAt) ? r.closesAt : undefined,
        message: ok2
          ? (word + " placed on " + (p.isDemo ? "Demo" : "REAL") + " ✅")
          : ("Trade failed" + (r && r.error ? ": " + r.error : (" — reload the " + BK + " tab.")))
      });
    });
    return true;
  }
  return false;
});

// Desktop: the app opens in its own resizable popup WINDOW (not a dropdown), so
// the user can drag its width and height freely and it stays open while they
// trade. One window at a time — a second click focuses the existing one.
//
// Firefox for Android has no `windows` API at all — there is no separate window
// to pop out there, so the toolbar tap falls back to the ordinary action popup
// (the same popup.html/popup.js, unchanged). That fallback is wired up once at
// load time via chrome.action.setPopup rather than a manifest "default_popup",
// because declaring default_popup would stop chrome.action.onClicked from ever
// firing — on every platform, not just mobile — and the desktop window-popout
// depends on that event.
var HAS_WINDOWS = typeof chrome.windows !== "undefined" && !!(chrome.windows && chrome.windows.create);

// Firefox suspends an MV3 event page after ~30 seconds idle and re-runs this file
// from the top when the next click wakes it, which wipes every module variable.
// So the open window's id cannot live in one: by the time the user clicks a second
// time it is always null again, and "focus the window you already have" silently
// became "open another one". It is kept in storage instead, where it survives the
// suspend, and each click re-checks the window is still there before deciding.
var APP_WINDOW_KEY = "cbAppWindowId";

function rememberAppWindow(id, cb) {
  var items = {};
  items[APP_WINDOW_KEY] = (id == null ? null : id);
  chrome.storage.local.set(items, function () { if (cb) { cb(); } });
}

// A click must never do nothing. Whenever the popup window cannot be created —
// no windows API, a platform that refuses the popup type, an error with no window
// back — the app still opens, as an ordinary tab on the same popup.html.
function openAppTab() {
  chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
}

function openAppWindow() {
  if (!HAS_WINDOWS) { openAppTab(); return; }
  chrome.windows.create({
    url: chrome.runtime.getURL("popup.html"),
    type: "popup",
    focused: true,
    width: 720,
    height: 900,
    top: 60,
    left: 120
  }, function (win) {
    if (chrome.runtime.lastError || !win || win.id == null) {
      console.warn("[SignalBots] the app window could not be opened ("
        + ((chrome.runtime.lastError && chrome.runtime.lastError.message) || "no window returned")
        + ") — opening it as a tab instead.");
      openAppTab();
      return;
    }
    rememberAppWindow(win.id);
    // Some platforms clamp/ignore create-time bounds for popup windows; set them
    // again so the app opens as a comfortable panel, not a thin strip.
    chrome.windows.update(win.id, { width: 720, height: 900, focused: true });
  });
}

function openOrFocusApp() {
  chrome.storage.local.get(APP_WINDOW_KEY, function (data) {
    var id = (data && data[APP_WINDOW_KEY] != null) ? data[APP_WINDOW_KEY] : null;
    if (id == null) { openAppWindow(); return; }
    chrome.windows.update(id, { focused: true }, function () {
      // The remembered window is gone (closed while we were suspended, or left
      // over from a previous session) — forget it and open a fresh one.
      if (chrome.runtime.lastError) { rememberAppWindow(null, openAppWindow); }
    });
  });
}

if (HAS_WINDOWS) {
  chrome.action.onClicked.addListener(function () {
    try {
      openOrFocusApp();
    } catch (e) {
      console.warn("[SignalBots] the app window could not be opened: " + e);
      openAppTab();
    }
  });

  chrome.windows.onRemoved.addListener(function (id) {
    chrome.storage.local.get(APP_WINDOW_KEY, function (data) {
      if (data && data[APP_WINDOW_KEY] === id) { rememberAppWindow(null); }
    });
  });
} else {
  chrome.action.setPopup({ popup: "popup.html" });
}
