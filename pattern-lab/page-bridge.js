// Pocket Pattern Lab page-world observer. Read-only: never sends broker commands.
(() => {
  "use strict";
  if (window.__PPL_OBSERVER_INSTALLED__) return;
  window.__PPL_OBSERVER_INSTALLED__ = true;

  const NativeWebSocket = window.WebSocket;
  const EVENTS = new Set([
    "updateAssets", "updateStream", "quotes/stream",
    "history/list/v2", "updateHistoryNew", "updateHistoryNewFast",
    "loadHistoryPeriod", "loadHistoryPeriodFast"
  ]);
  let socketCount = 0, eventCount = 0;

  function emit(kind, payload) {
    try {
      window.postMessage({
        source: "POCKET_PATTERN_LAB_PAGE",
        kind,
        payload,
        receivedAt: Date.now()
      }, "*");
    } catch (_) {}
  }

  function parseSocketEvent(raw) {
    if (typeof raw !== "string") return;
    // Socket.IO event packet: 42["eventName", payload]
    const start = raw.search(/[\[{]/);
    if (start < 0) return;
    let packet;
    try { packet = JSON.parse(raw.slice(start)); } catch (_) { return; }
    if (!Array.isArray(packet) || typeof packet[0] !== "string") return;
    const name = packet[0];
    if (!EVENTS.has(name)) return;
    eventCount++;
    emit(name, packet[1]);
  }

  function ObserverWebSocket(url, protocols) {
    const ws = protocols === undefined
      ? new NativeWebSocket(url)
      : new NativeWebSocket(url, protocols);
    socketCount++;
    emit("SOCKET", { connected: true, socketCount, url: String(url || "").slice(0, 180) });
    ws.addEventListener("message", event => {
      if (typeof event.data === "string") {
        parseSocketEvent(event.data);
      } else if (event.data instanceof Blob) {
        // Binary Socket.IO attachments are deliberately not decoded until their
        // framing is verified against a live capture.
      }
    });
    ws.addEventListener("close", () => emit("SOCKET", { connected: false, socketCount }));
    return ws;
  }

  ObserverWebSocket.prototype = NativeWebSocket.prototype;
  Object.setPrototypeOf(ObserverWebSocket, NativeWebSocket);
  for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
    ObserverWebSocket[key] = NativeWebSocket[key];
  }
  try { window.WebSocket = ObserverWebSocket; } catch (_) {}
  emit("READY", { socketCount, eventCount });
})();
