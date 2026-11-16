"use strict";

(() => {
  const isTracker = location.hostname === "127.0.0.1" ||
    location.hostname === "localhost";
  const isBroker = /(^|\\.)pocketoption\\.com$/i.test(location.hostname);
  if (!isTracker && !isBroker) return;

  const seen = new Set();
  let panel;

  function ensurePanel() {
    if (panel && panel.isConnected) return panel;
    panel = document.createElement("section");
    panel.id = "pocket-tracker-signal-bridge";
    panel.style.cssText = [
      "position:fixed","right:18px","top:90px","z-index:2147483647",
      "width:290px","padding:14px","border:1px solid #34465d",
      "border-radius:14px","background:#101824","color:#e8eef6",
      "box-shadow:0 12px 36px #0008","font:13px/1.45 system-ui,sans-serif",
      "display:none"
    ].join(";");
    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <strong style="font-size:14px">Pocket Tracker</strong>
        <button type="button" data-close aria-label="Закрыть" style="background:#263548;color:#fff;border:0;border-radius:8px;padding:4px 9px;cursor:pointer">×</button>
      </div>
      <div data-status style="color:#9fb0c5;margin-top:8px">Ожидание сигнала</div>
      <div data-details style="margin-top:10px"></div>
      <div style="font-size:11px;color:#f0c477;margin-top:10px">Сигнальный режим: ордера брокеру не отправляются.</div>
    `;
    panel.querySelector("[data-close]").addEventListener("click", () => {
      panel.style.display = "none";
    });
    document.documentElement.appendChild(panel);
    return panel;
  }

  function showSignal(signal) {
    if (!signal || seen.has(signal.id)) return;
    seen.add(signal.id);
    if (seen.size > 300) seen.delete(seen.values().next().value);
    const root = ensurePanel();
    const direction = signal.direction === "CALL" ? "ВВЕРХ · CALL" : "ВНИЗ · PUT";
    root.querySelector("[data-status]").textContent = "Новый сигнал · " + direction;
    root.querySelector("[data-details]").textContent =
      signal.asset + " · 5 секундная свеча · экспирация 15 секунд. " +
      "Цена: " + Number(signal.entryPrice).toPrecision(8) +
      " · RSI: " + Number(signal.rsi).toFixed(2) +
      " · отклонение BB: " + Number(signal.distancePoints).toFixed(2) + " пункта.";
    root.style.display = "block";
  }

  if (isTracker) {
    window.addEventListener("message", event => {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data;
      if (!data || data.source !== "pocket-tracker" ||
          data.type !== "strategy-signal" || !data.signal) return;
      chrome.runtime.sendMessage({ type: "PT_FORWARD_SIGNAL", signal: data.signal });
    });
  }

  if (isBroker) {
    chrome.runtime.onMessage.addListener(message => {
      if (message && message.type === "PT_SIGNAL") showSignal(message.signal);
    });
    ensurePanel().querySelector("[data-status]").textContent =
      "Связь готова. Ожидаю сигналы от Pocket Tracker.";
    panel.style.display = "block";
  }
})();
