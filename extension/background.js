"use strict";

const PO_URLS = ["https://pocketoption.com/*", "https://*.pocketoption.com/*"];
const TRACKER_URLS = ["http://127.0.0.1/*", "http://localhost/*"];
const STORAGE_KEY = "ptBrokerMonitor";

function validSignal(signal) {
  return signal && ["CALL", "PUT"].includes(signal.direction) &&
    signal.period === 5 && signal.durationSeconds === 15 &&
    typeof signal.id === "string";
}
function sendToBroker(message) {
  chrome.tabs.query({ url: PO_URLS }, tabs => {
    for (const tab of tabs) if (tab.id != null) chrome.tabs.sendMessage(tab.id, message).catch(() => {});
  });
}
function sendToTracker(message) {
  chrome.tabs.query({ url: TRACKER_URLS }, tabs => {
    for (const tab of tabs) if (tab.id != null) chrome.tabs.sendMessage(tab.id, message).catch(() => {});
  });
}
async function updateMonitor(patch) {
  const current = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {};
  await chrome.storage.local.set({ [STORAGE_KEY]: { ...current, ...patch, updatedAt: Date.now() } });
}
chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === "PT_FORWARD_SIGNAL" && validSignal(message.signal)) {
    sendToBroker({ type: "PT_SIGNAL", signal: message.signal });
    updateMonitor({ lastSignal: message.signal, lastSignalAt: Date.now() }).catch(() => {});
  }
  if (message.type === "PT_MANUAL_TRADE") {
    const amount = Number(message.amount);
    if (["CALL","PUT"].includes(message.direction) && Number.isFinite(amount) && amount >= 1 && amount <= 50000) {
      sendToTracker({ type:"PT_MANUAL_TRADE", direction:message.direction, amount });
    }
  }
  if (message.type === "PT_SET_AUTO_TRADING") {
    const amount = Number(message.amount);
    if (Number.isFinite(amount) && amount >= 1 && amount <= 50000) {
      sendToTracker({ type:"PT_SET_AUTO_TRADING", enabled:Boolean(message.enabled), amount });
    }
  }
  if (message.type === "PT_EXECUTION_STATE" && message.payload) {
    const patch = {};
    if (message.event === "accountState") patch.accountState = message.payload;
    if (message.event === "executionState") patch.executionState = message.payload;
    if (message.event === "orderResult") patch.lastOrderResult = message.payload;
    updateMonitor(patch).catch(() => {});
  }
  if (message.type === "PT_TEST_BROADCAST") {
    sendToBroker({ type: "PT_TEST_SIGNAL", signal: {
      id: "test-" + Date.now(), direction: "CALL", asset: "ТЕСТ ДОСТАВКИ",
      period: 5, durationSeconds: 15, entryPrice: 1.23456, rsi: 20,
      distancePoints: 0.5, createdAt: Date.now()
    }});
  }
  if (message.type === "PT_BROKER_STATE" && message.state) {
    updateMonitor({ state: message.state }).catch(() => {});
  }
  if (message.type === "PT_MARKET_EVENT" && message.event) {
    updateMonitor({ lastMarketEvent: message.event, lastMarketAt: Date.now() }).catch(() => {});
  }
});