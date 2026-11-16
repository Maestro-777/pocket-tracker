"use strict";

/*
 * Read-only Pocket Option page hook.
 * Captures only market event payloads and the isDemo flag from the auth frame.
 * Session tokens, uid, cookies and other auth fields are never forwarded.
 */
(() => {
  if (window.__PT_PAGE_HOOK_INSTALLED__) return;
  Object.defineProperty(window, "__PT_PAGE_HOOK_INSTALLED__", { value: true });

  const NativeWebSocket = window.WebSocket;
  const allowedEvents = new Set([
    "successauth", "loadHistoryPeriodFast", "updateStream", "updateAssets"
  ]);

  function emit(type, payload) {
    try {
      window.postMessage({
        source: "pt-pocketoption-page-hook",
        type,
        payload
      }, location.origin);
    } catch (_) {}
  }

  function parseSocketFrame(raw, incoming) {
    if (typeof raw !== "string" || !raw.startsWith("42")) return;
    let parsed;
    try { parsed = JSON.parse(raw.slice(2)); } catch (_) { return; }
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string") return;
    const name = parsed[0];
    const data = parsed.length > 1 ? parsed[1] : null;

    if (!incoming && name === "auth" && data && typeof data === "object") {
      const flag = data.isDemo;
      const isDemo = flag === 1 || flag === true || String(flag).toLowerCase() === "true";
      emit("account", { isDemo, detectedAt: Date.now() });
      return;
    }
    if (incoming && allowedEvents.has(name)) {
      if (name === "successauth") emit("broker-auth", { authenticated: true, at: Date.now() });
      else emit("market-event", { name, data, at: Date.now() });
    }
  }

  function WrappedWebSocket(...args) {
    const socket = new NativeWebSocket(...args);
    try {
      socket.addEventListener("message", event => parseSocketFrame(event.data, true));
      const originalSend = socket.send;
      socket.send = function(data) {
        parseSocketFrame(data, false);
        return originalSend.call(this, data);
      };
    } catch (_) {}
    return socket;
  }
  WrappedWebSocket.prototype = NativeWebSocket.prototype;
  Object.setPrototypeOf(WrappedWebSocket, NativeWebSocket);
  for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
    Object.defineProperty(WrappedWebSocket, key, { value: NativeWebSocket[key] });
  }
  try { window.WebSocket = WrappedWebSocket; } catch (_) {}
})();