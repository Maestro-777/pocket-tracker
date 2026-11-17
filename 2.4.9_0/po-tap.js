/*
 * PocketOption main-world WebSocket tap.
 *
 * Runs in the PAGE's own JavaScript world (manifest `world: "MAIN"`) at
 * document_start, so it wraps window.WebSocket before PocketOption's bundle ever
 * constructs one. It never opens a connection of its own: it listens in on the
 * page's already-authenticated socket and forwards two things to the isolated
 * content script (pocket-socket.js) over window.postMessage —
 *
 *   assets  — the full tradeable instrument table PocketOption pushes as the
 *             `updateAssets` event (symbol + payout per row), which is the only
 *             always-live source for the pair list. The currency-pair picker's
 *             DOM exists only while the user has that panel open, so DOM scraping
 *             alone leaves the list empty in normal use.
 *   symbol  — the charted symbol, from the `updateCharts` push and the page's own
 *             outgoing `changeSymbol` emit.
 *   orderAck — the broker's answer to an order (`openOrder` / `successopenOrder` /
 *             `failopenOrder`). The extension places orders on its own socket but
 *             the broker does not reliably answer there, so an ack heard on the
 *             page's socket settles the same pending order.
 *
 * Why a tap instead of reading these off our own socket: PocketOption delivers
 * `updateAssets` as a Socket.IO BINARY attachment event (`451-[...]` header frame
 * followed by a binary frame holding the JSON). A parser that stringifies every
 * frame and ignores packet type 45 silently drops it — which is exactly why an
 * earlier build concluded the broker "never sends" this data. Our own client now
 * parses binary frames too, but the page's socket is the authoritative one: it is
 * always connected and always authorised, with no second auth to keep alive.
 */
(function () {
  "use strict";

  var TAG = "SB_PO_TAP";
  if (window.__SB_PO_TAP__) { return; }
  window.__SB_PO_TAP__ = true;

  var Native = window.WebSocket;
  if (typeof Native !== "function") { return; }

  var decoder = new TextDecoder();
  var logged = { sample: false };

  // The page's own socket, kept so the content script can send over it.
  //
  // Firefox needs this, and PocketOption needs it more than the other brokers do.
  // A Manifest V3 content script's WebSocket is made in the PAGE's context, where
  // a "*://" host permission does not reliably cover a wss:// URL - and worse,
  // PocketOption publishes its socket servers at RUNTIME (AppData servers-list),
  // on hosts that cannot be listed in a manifest written months earlier. This
  // socket is already connected to whichever server the broker chose, and already
  // authorised.
  var pageSocket = null;

  // Last successful reads, replayed on request. The content script loads at
  // document_idle, well after this tap starts capturing, so anything pushed
  // before its listener exists would otherwise be lost until the next push.
  var snapshot = { assets: null, assetsAt: 0, symbol: null, symbolAt: 0, creds: null };

  function post(event, payload) {
    try { window.postMessage({ __sb: TAG, event: event, payload: payload }, "*"); } catch (e) {}
  }

  // "AUDCAD_otc" -> "AUDCAD". Kept verbatim otherwise.
  function baseCode(sym) { return String(sym || "").replace(/_otc$/i, "").toUpperCase(); }

  // One `updateAssets` row is a long positional array. Only three positions are
  // documented by PocketOption's own client behaviour: [1] the instrument symbol
  // and [5] the current payout percentage, with [2] a display name. Whether the
  // instrument is open right now is carried by a boolean somewhere further along
  // whose index is not stable across builds, so take it only when the row has
  // exactly one boolean and assume open otherwise — a wrongly-open pair simply
  // fails to trade, while a wrongly-closed one would vanish from the list.
  function rowOpen(row) {
    var found = null, count = 0;
    for (var i = 0; i < row.length; i++) {
      if (typeof row[i] === "boolean") { count++; found = row[i]; }
    }
    return count === 1 ? found : true;
  }

  function slimAssets(rows) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!Array.isArray(r) || r.length < 6) { continue; }
      if (typeof r[1] !== "string" || !r[1]) { continue; }
      out.push({
        symbol: r[1],
        code: baseCode(r[1]),
        otc: /_otc$/i.test(r[1]),
        name: typeof r[2] === "string" ? r[2] : null,
        payout: typeof r[5] === "number" ? r[5] : null,
        open: rowOpen(r)
      });
    }
    return out;
  }

  function onAssets(rows) {
    if (!Array.isArray(rows) || !rows.length) { return; }
    if (!logged.sample) {
      logged.sample = true;
      // One row, once, so the positional schema above can be verified against a
      // real payload instead of inferred.
      try { console.log("[SignalBots] PO tap updateAssets sample row:", JSON.stringify(rows[0])); } catch (e) {}
    }
    var list = slimAssets(rows);
    if (!list.length) { return; }
    snapshot.assets = list;
    snapshot.assetsAt = Date.now();
    post("assets", { list: list });
  }

  function onSymbol(sym) {
    var code = baseCode(sym);
    if (!code || code === snapshot.symbol) { return; }
    snapshot.symbol = code;
    snapshot.symbolAt = Date.now();
    post("symbol", { current: code, raw: String(sym) });
  }

  // `updateCharts` carries the active chart's settings as a JSON string.
  function symbolFromCharts(arg) {
    if (!Array.isArray(arg) || !arg.length) { return null; }
    var first = arg[0];
    if (!first || typeof first !== "object" || typeof first.settings !== "string") { return null; }
    try {
      var s = JSON.parse(first.settings);
      return typeof s.symbol === "string" ? s.symbol : null;
    } catch (e) { return null; }
  }

  // Order acks. PocketOption does not reliably deliver these to the second,
  // passive connection the extension opens — the page's own socket is the one
  // the backend answers on, and an ack we never hear is an order that opened for
  // real and got reported as failed. So the tap forwards them and the content
  // script settles on whichever socket answers first.
  function onOrderAck(name, arg) {
    if (!arg || typeof arg !== "object") { return; }
    // Forward the broker's ack whole. An earlier version copied out four fields
    // and dropped openTimestamp/closeTimestamp — the very numbers the expiry
    // check needs — so every order confirmed through this path reported "the
    // broker did not state a duration" and was never verified at all.
    var ack = {};
    Object.keys(arg).forEach(function (k) {
      var v = arg[k];
      var t = typeof v;
      if (t === "number" || t === "string" || t === "boolean") { ack[k] = v; }
    });
    ack.ok = name !== "failopenOrder";
    ack.event = name;
    post("orderAck", ack);
  }

  function dispatch(name, args) {
    if (name === "updateAssets") { onAssets(args[0]); return; }
    // Only forwarded because the engine may be running ON this socket; when it
    // has its own, its own balance events arrive there and these are ignored.
    if (name === "TotalBalance" || name === "successupdateBalance") {
      if (args[0] && typeof args[0] === "object") { post("balance", args[0]); }
      return;
    }
    if (name === "openOrder" || name === "successopenOrder" || name === "failopenOrder") {
      onOrderAck(name, args[0]);
      return;
    }
    if (name === "updateCharts") {
      var sym = symbolFromCharts(args[0]);
      if (sym) { onSymbol(sym); }
      return;
    }
    if (name === "changeSymbol") {
      var a = args[0];
      if (a && typeof a === "object" && typeof a.asset === "string") { onSymbol(a.asset); }
      else if (typeof a === "string") { onSymbol(a); }
    }
  }

  // Socket.IO v4 framing, text and binary. A binary event arrives as a header
  // frame `45<N>-["name",{"_placeholder":true,"num":0}]` followed by exactly N
  // binary frames; each placeholder is replaced by its decoded attachment.
  function Reader() {
    this.pending = null;
  }
  Reader.prototype.feed = function (text, isBinary) {
    if (isBinary) {
      if (!this.pending) { return; }
      this.pending.attachments.push(parseMaybe(text));
      if (this.pending.attachments.length >= this.pending.expected) {
        var p = this.pending;
        this.pending = null;
        dispatch(p.name, [inject(p.template, p.attachments)]);
      }
      return;
    }
    if (text.indexOf("42") === 0) {
      var arr = parseMaybe(text.slice(2));
      if (Array.isArray(arr) && typeof arr[0] === "string") { dispatch(arr[0], arr.slice(1)); }
      return;
    }
    var m = /^45(\d+)-([\s\S]+)$/.exec(text);
    if (!m) { return; }
    var n = Number(m[1]);
    var head = parseMaybe(m[2]);
    if (!Number.isInteger(n) || n <= 0 || !Array.isArray(head) || typeof head[0] !== "string") { return; }
    this.pending = {
      expected: n,
      attachments: [],
      name: head[0],
      template: head.length > 1 ? head[1] : null
    };
  };

  function parseMaybe(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function isPlaceholder(v) {
    return !!v && typeof v === "object" && v._placeholder === true && typeof v.num === "number";
  }

  function inject(template, attachments) {
    if (isPlaceholder(template)) { return attachments[template.num] != null ? attachments[template.num] : null; }
    if (Array.isArray(template)) { return template.map(function (v) { return inject(v, attachments); }); }
    if (template && typeof template === "object") {
      var out = {};
      Object.keys(template).forEach(function (k) { out[k] = inject(template[k], attachments); });
      return out;
    }
    return template;
  }

  // What the PAGE sends. PocketOption's own client is the only authority on how an
  // order is encoded — above all what `time` means for a sub-minute expiry, which
  // the extension must match exactly or it opens a position of the wrong length.
  // Logged verbatim, never forwarded: this is a diagnostic surface, not a feature.
  function watchOutgoing(ws) {
    var send = ws.send;
    ws.send = function (data) {
      try {
        if (typeof data === "string" && data.indexOf('42["openOrder"') === 0) {
          console.log("[SignalBots] PAGE openOrder ->", data.slice(2));
        } else if (typeof data === "string" && data.indexOf('42["auth"') === 0) {
          onPageAuth(parseMaybe(data.slice(2)));
        }
      } catch (e) {}
      return send.apply(this, arguments);
    };
  }

  // The identity, taken from the page authenticating itself.
  //
  // The extension normally reads this out of window.AppData and the ci_session
  // cookie. On Firefox that path kept coming back empty, and without a uid the
  // worker gives up before it ever opens a socket - which is why the popup said
  // "Open your PocketOption tab" while the tab was right there. The page is
  // authenticating on this very socket with exactly the fields we need, so they
  // are read from the frame it sends rather than reconstructed from the DOM.
  //
  // Nothing here is trusted blindly: the content script uses it only when its own
  // read failed, and checks the shape before it does.
  function onPageAuth(arr) {
    if (!Array.isArray(arr) || arr.length < 2) { return; }
    var a = arr[1];
    if (!a || typeof a !== "object") { return; }
    if (a.uid == null || typeof a.session !== "string" || !a.session) { return; }
    var creds = {
      uid: a.uid,
      session: a.session,
      isDemo: a.isDemo === 1 || a.isDemo === true,
      platform: a.platform
    };
    if (snapshot.creds && snapshot.creds.session === creds.session
      && snapshot.creds.isDemo === creds.isDemo) { return; }
    snapshot.creds = creds;
    console.log("[SignalBots] PO tap read the page's identity (uid " + creds.uid
      + ", " + (creds.isDemo ? "demo" : "real") + ")");
    post("creds", creds);
  }

  // Frames must reach the reader in arrival order, and reading a Blob is async,
  // so every frame goes through one serial promise chain.
  function attach(ws) {
    var reader = new Reader();
    var chain = Promise.resolve();
    watchOutgoing(ws);
    pageSocket = ws;
    post("socket", { open: true });
    ws.addEventListener("close", function () {
      if (pageSocket === ws) { pageSocket = null; post("socket", { open: false }); }
    });
    ws.addEventListener("message", function (ev) {
      chain = chain.then(function () { return toText(ev.data); }).then(function (f) {
        if (f) { try { reader.feed(f.text, f.binary); } catch (e) {} }
      });
    });
  }

  // Duck-typed rather than `instanceof ArrayBuffer`: the frame can arrive as an
  // ArrayBuffer, a typed-array view over one, or a Blob, depending on what the
  // page set as its binaryType.
  function toText(data) {
    if (typeof data === "string") { return { text: data, binary: false }; }
    if (data && typeof data.byteLength === "number") {
      var view = (typeof data.buffer !== "undefined") ? data : new Uint8Array(data);
      return { text: decoder.decode(view), binary: true };
    }
    if (data && typeof data.arrayBuffer === "function") {
      return data.arrayBuffer().then(function (buf) {
        return { text: decoder.decode(new Uint8Array(buf)), binary: true };
      }, function () { return null; });
    }
    return null;
  }

  // Transparent subclass: instanceof, static constants, prototype methods and
  // every property keep working, so the page cannot tell the difference.
  function Tapped(url, protocols) {
    var ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
    try { if (/socket\.io/i.test(String(url))) { attach(ws); } } catch (e) {}
    return ws;
  }
  Tapped.prototype = Native.prototype;
  Tapped.CONNECTING = Native.CONNECTING;
  Tapped.OPEN = Native.OPEN;
  Tapped.CLOSING = Native.CLOSING;
  Tapped.CLOSED = Native.CLOSED;

  try {
    Object.defineProperty(window, "WebSocket", {
      value: Tapped, writable: true, configurable: true, enumerable: false
    });
  } catch (e) { return; }

  // Requests from the content script: replay what was captured before it loaded,
  // and relay frames onto the page's socket.
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) { return; }
    var d = ev.data;
    if (!d || d.__sb !== TAG) { return; }

    if (d.req === "SNAPSHOT") {
      if (pageSocket) { post("socket", { open: true }); }
      if (snapshot.creds) { post("creds", snapshot.creds); }
      if (snapshot.assets) { post("assets", { list: snapshot.assets, replay: true }); }
      if (snapshot.symbol) { post("symbol", { current: snapshot.symbol, replay: true }); }
      return;
    }

    // Relay. Only ever a socket.io text frame the engine built - this is a
    // transport, not an instruction channel, so nothing here inspects or
    // rewrites what it is asked to send.
    if (d.req === "EMIT" && typeof d.frame === "string") {
      if (!pageSocket || pageSocket.readyState !== 1) { post("emit", { ok: false }); return; }
      try { pageSocket.send(d.frame); post("emit", { ok: true }); }
      catch (e) { post("emit", { ok: false }); }
    }
  });

  console.log("[SignalBots] PocketOption socket tap installed");
})();
