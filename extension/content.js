"use strict";

(() => {
  const host = location.hostname.toLowerCase();
  const isTracker = host === "127.0.0.1" || host === "localhost";
  const isBroker = /^(?:[a-z0-9-]+\\.)*pocketoption\\.com$/i.test(host);
  if (!isTracker && !isBroker) return;

  let panel;
  let lastSignal = null;
  let signalCount = 0;
  let marketState = { account: "unknown", authenticated: false, lastMarketAt: 0, candleCount: 0, lastAsset: "" };

  function ensurePanel() {
    if (panel && panel.isConnected) return panel;
    panel = document.createElement("section");
    panel.id = "pocket-tracker-signal-bridge";
    panel.style.cssText = "position:fixed;right:18px;top:90px;z-index:2147483647;width:310px;padding:14px;border:1px solid #34465d;border-radius:14px;background:#101824;color:#e8eef6;box-shadow:0 12px 36px #0008;font:13px/1.45 system-ui,sans-serif;display:none";
    panel.innerHTML = '<div style="display:flex;justify-content:space-between"><strong>Pocket Tracker</strong><button data-close style="background:#263548;color:#fff;border:0;border-radius:8px;padding:4px 9px">Свернуть</button></div><div data-state style="margin-top:9px;color:#9fb0c5">Ожидание данных Pocket Option</div><div data-details style="margin-top:8px"></div><div style="font-size:11px;color:#f0c477;margin-top:10px">Прямой мониторинг · торговля заблокирована</div>';
    panel.querySelector("[data-close]").addEventListener("click", () => panel.style.display = "none");
    document.documentElement.appendChild(panel);
    return panel;
  }

  function paintPanel() {
    if (!isBroker) return;
    const root = ensurePanel();
    const account = marketState.account === "demo" ? "DEMO" : marketState.account === "real" ? "REAL" : "НЕ ОПРЕДЕЛЁН";
    const safe = marketState.account === "demo";
    root.querySelector("[data-state]").textContent = "Счёт: " + account + " · " +
      (marketState.authenticated ? "авторизация подтверждена" : "ожидание авторизации");
    root.querySelector("[data-details]").textContent =
      "Рыночные события: " + marketState.candleCount +
      " · инструмент: " + (marketState.lastAsset || "ожидание") +
      " · последние данные: " + (marketState.lastMarketAt ? new Date(marketState.lastMarketAt).toLocaleTimeString() : "нет") +
      " · исполнение: " + (safe ? "DEMO допущен к следующему этапу" : "заблокировано");
    root.style.display = "block";
  }

  function sendState() {
    chrome.runtime.sendMessage({ type: "PT_BROKER_STATE", state: marketState }).catch(() => {});
    paintPanel();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "PT_PING") {
      sendResponse({ ok: true, role: isTracker ? "tracker" : "broker", url: location.href, title: document.title, lastSignal, signalCount, marketState });
      return;
    }
    if (isBroker && message?.type === "PT_GET_BROKER_STATE") {
      sendResponse({ ok: true, marketState });
      return;
    }
    if (isBroker && message?.type === "PT_SIGNAL") {
      lastSignal = { ...message.signal, receivedAt: Date.now() };
      signalCount++;
      paintPanel();
    }
    if (isBroker && message?.type === "PT_TEST_SIGNAL") {
      lastSignal = { ...message.signal, receivedAt: Date.now(), test: true };
      paintPanel();
    }
  });

  if (isBroker) {
    window.addEventListener("message", event => {
      if (event.source !== window || event.origin !== location.origin) return;
      const msg = event.data;
      if (!msg || msg.source !== "pt-pocketoption-page-hook") return;
      if (msg.type === "account") {
        marketState.account = msg.payload?.isDemo === true ? "demo" : "real";
        sendState();
      } else if (msg.type === "broker-auth") {
        marketState.authenticated = true;
        sendState();
      } else if (msg.type === "market-event") {
        marketState.lastMarketAt = Date.now();
        const data = msg.payload?.data;
        if (msg.payload?.name === "updateStream") {
          const text = JSON.stringify(data);
          const match = text.match(/[A-Za-z0-9_#]{3,32}/);
          if (match) marketState.lastAsset = match[0];
          marketState.candleCount++;
        } else if (msg.payload?.name === "loadHistoryPeriodFast") {
          marketState.candleCount += Array.isArray(data) ? data.length : 1;
        }
        // Only the market payload is forwarded; no auth frame is ever forwarded.
        chrome.runtime.sendMessage({
          type: "PT_MARKET_EVENT",
          event: { name: msg.payload?.name, data: msg.payload?.data, at: msg.payload?.at }
        }).catch(() => {});
        sendState();
      }
    });
    ensurePanel().querySelector("[data-state]").textContent = "Хук установлен · ожидаю авторизацию и поток";
    panel.style.display = "block";
  }

  if (isTracker) {
    window.addEventListener("message", event => {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data;
      if (data?.source === "pocket-tracker" && data.type === "strategy-signal" && data.signal) {
        chrome.runtime.sendMessage({ type: "PT_FORWARD_SIGNAL", signal: data.signal }).catch(() => {});
      }
    });
  }
})();