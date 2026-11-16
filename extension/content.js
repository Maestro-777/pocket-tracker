"use strict";

(() => {
  const host = location.hostname.toLowerCase();
  const isTracker = host === "127.0.0.1" || host === "localhost";
  const isBroker = /^(?:[a-z0-9-]+\\.)*pocketoption\\.com$/i.test(host);
  if (!isTracker && !isBroker) return;

  const seen = new Set();
  let panel;
  let lastSignal = null;
  let signalCount = 0;

  function ensurePanel() {
    if (panel && panel.isConnected) return panel;
    panel = document.createElement("section");
    panel.id = "pocket-tracker-signal-bridge";
    panel.style.cssText = [
      "position:fixed","right:18px","top:90px","z-index:2147483647",
      "width:300px","padding:14px","border:1px solid #34465d",
      "border-radius:14px","background:#101824","color:#e8eef6",
      "box-shadow:0 12px 36px #0008","font:13px/1.45 system-ui,sans-serif",
      "display:none"
    ].join(";");
    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <strong style="font-size:14px">Pocket Tracker</strong>
        <button type="button" data-close aria-label="Свернуть" style="background:#263548;color:#fff;border:0;border-radius:8px;padding:4px 9px;cursor:pointer">Свернуть</button>
      </div>
      <div data-status style="color:#9fb0c5;margin-top:8px">Ожидание сигнала</div>
      <div data-details style="margin-top:10px"></div>
      <div data-count style="font-size:11px;color:#9fb0c5;margin-top:8px">Получено сигналов: 0</div>
      <div style="font-size:11px;color:#f0c477;margin-top:10px">Только уведомления. Ордера брокеру не отправляются.</div>
    `;
    panel.querySelector("[data-close]").addEventListener("click", () => {
      panel.style.display = "none";
    });
    document.documentElement.appendChild(panel);
    return panel;
  }

  function showSignal(signal, isTest) {
    if (!signal || (!isTest && seen.has(signal.id))) return;
    if (!isTest) {
      seen.add(signal.id);
      if (seen.size > 300) seen.delete(seen.values().next().value);
      signalCount++;
    }
    lastSignal = { ...signal, receivedAt: Date.now(), test: !!isTest };
    const root = ensurePanel();
    const direction = signal.direction === "CALL" ? "ВВЕРХ · CALL" : "ВНИЗ · PUT";
    root.querySelector("[data-status]").textContent =
      (isTest ? "Тестовое уведомление · " : "НОВЫЙ СИГНАЛ · ") + direction;
    root.querySelector("[data-details]").textContent = isTest
      ? "Тест доставки прошёл. Это не торговая сделка."
      : String(signal.asset) + " · свеча 5с · экспирация 15с · цена " +
        Number(signal.entryPrice).toPrecision(8) + " · RSI " +
        Number(signal.rsi).toFixed(2) + " · BB " +
        Number(signal.distancePoints).toFixed(2) + " пункта.";
    root.querySelector("[data-count]").textContent = "Получено сигналов: " + signalCount;
    root.style.display = "block";
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === "PT_PING") {
      sendResponse({
        ok: true,
        role: isTracker ? "tracker" : "broker",
        url: location.href,
        title: document.title,
        lastSignal,
        signalCount
      });
      return;
    }
    if (isBroker && message && message.type === "PT_SIGNAL") showSignal(message.signal, false);
    if (isBroker && message && message.type === "PT_TEST_SIGNAL") showSignal(message.signal, true);
  });

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
    ensurePanel().querySelector("[data-status]").textContent =
      "Расширение подключено. Ожидаю сигналы от Pocket Tracker.";
    panel.style.display = "block";
  }
})();
