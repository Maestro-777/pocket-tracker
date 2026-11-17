(() => {
  "use strict";
  if (window.__POCKET_DATA_COLLECTOR_BRIDGE__) return;
  window.__POCKET_DATA_COLLECTOR_BRIDGE__ = true;

  const NativeWebSocket = window.WebSocket;
  if (!NativeWebSocket) return;
  let openSockets = 0;
  let totalSockets = 0;
  let lastEvent = 0;
  let pendingBinaryEvent = null;

  const watched = new Set([
    "successauth", "user_ready", "updateAssets", "updateCharts",
    "updateStream", "quotes/stream", "history/list/v2",
    "updateHistoryNew", "updateHistoryNewFast",
    "loadHistoryPeriod", "loadHistoryPeriodFast"
  ]);

  function send(kind, payload) {
    try {
      window.postMessage({
        __pdc: "POCKET_DATA_COLLECTOR",
        kind,
        payload: payload === undefined ? null : payload,
        at: Date.now()
      }, "*");
    } catch (_) {}
  }

  function parseEvent(raw) {
    if (typeof raw !== "string") return;
    const start = raw.search(/[\[{]/);
    if (start < 0) return;
    let packet;
    try { packet = JSON.parse(raw.slice(start)); } catch (_) { return; }
    if (!Array.isArray(packet) || typeof packet[0] !== "string") return;
    const name = packet[0];
    const payload = packet[1];
    if (!watched.has(name)) return;
    if (payload && payload._placeholder === true) {
      pendingBinaryEvent = name;
      return;
    }
    lastEvent = Date.now();
    send("PO_EVENT", { name, payload });
  }

  function decodeBinary(data) {
    try {
      const bytes = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
      const decoded = new TextDecoder("utf-8").decode(bytes);
      let value;
      try { value = JSON.parse(decoded); } catch (_) { return; }
      if (pendingBinaryEvent) {
        const name = pendingBinaryEvent;
        pendingBinaryEvent = null;
        lastEvent = Date.now();
        send("PO_EVENT", { name, payload: value });
      }
    } catch (_) {}
  }

  function wrapSocket(ws, url) {
    totalSockets++;
    send("SOCKET", { state: ws.readyState === 1 ? "open" : "connecting", totalSockets, openSockets, url: String(url || "").slice(0, 160) });
    ws.addEventListener("open", () => {
      openSockets++;
      send("SOCKET", { state: "open", totalSockets, openSockets });
    });
    ws.addEventListener("close", () => {
      if (ws.__pdcWasOpen) openSockets = Math.max(0, openSockets - 1);
      send("SOCKET", { state: openSockets > 0 ? "open" : "closed", totalSockets, openSockets });
    });
    ws.addEventListener("message", event => {
      if (typeof event.data === "string") parseEvent(event.data);
      else if (event.data instanceof ArrayBuffer) decodeBinary(event.data);
      else if (event.data instanceof Blob) event.data.arrayBuffer().then(decodeBinary).catch(() => {});
    });
    // Account for sockets which were already open before listeners were attached.
    if (ws.readyState === 1) {
      ws.__pdcWasOpen = true;
      openSockets++;
    } else {
      ws.addEventListener("open", () => { ws.__pdcWasOpen = true; }, { once: true });
    }
  }

  try {
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args) {
        const ws = Reflect.construct(target, args, target);
        wrapSocket(ws, args[0]);
        return ws;
      }
    });
  } catch (_) {
    send("BRIDGE_ERROR", { message: "Не удалось установить наблюдатель WebSocket" });
  }

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function cleanPair(raw) {
    return String(raw || "").trim().split("\n")[0]
      .replace(/\s*\(?\s*OTC\s*\)?\s*$/i, "_OTC")
      .replace(/[\s/]+/g, "").toUpperCase();
  }

  function readPair() {
    const selectors = [
      ".assets-block__item--active", ".assets-block__item.active",
      '[class*="asset-item"].active', '[class*="asset-item--active"]',
      ".pairs-list__item.active", ".pairs-list__item--active",
      ".current-symbol", ".pair-number-wrap .pair", ".block__title-pair",
      '[class*="current-pair"]', '[class*="currentPair"]',
      '[class*="symbol-name"]', '[class*="symbolName"]',
      '[class*="asset-name"]', '[class*="assetName"]',
      '[class*="pair-name"]', '[class*="pairName"]',
      ".a-symbol__name", ".chart-symbol", '[class*="instrument-name"]'
    ];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue;
        const raw = el.getAttribute("data-asset") || el.getAttribute("data-symbol") ||
          el.getAttribute("data-pair") || el.textContent;
        const pair = cleanPair(raw);
        if (/^[A-Z0-9#]{4,}(_OTC)?$/.test(pair)) return pair;
      }
    }
    return "UNKNOWN";
  }

  function parseMoney(raw) {
    const s = String(raw || "").replace(/[^0-9,.-]/g, "").replace(/,(?=\d{1,2}$)/, ".");
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function readBalance() {
    const selectors = [
      '[class*="balance"] [class*="value"]',
      '[class*="balance"] [class*="amount"]',
      '[class*="balance-value"]',
      '[class*="balance__value"]',
      '[data-balance]',
      '[class*="header"] [class*="balance"]',
      '[class*="user-balance"]'
    ];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue;
        const raw = el.getAttribute("data-balance") || el.getAttribute("data-value") || el.textContent;
        const value = parseMoney(raw);
        if (value !== null) return { value, raw: String(raw).trim().slice(0, 50), source: "page" };
      }
    }
    return null;
  }

  function readPageState() {
    send("PAGE_STATE", {
      pair: readPair(),
      balance: readBalance(),
      url: location.href,
      title: document.title,
      frame: window === window.top ? "top" : "frame",
      lastEvent
    });
  }

  readPageState();
  setInterval(readPageState, 1200);
  send("BRIDGE_READY", { href: location.href });
})();