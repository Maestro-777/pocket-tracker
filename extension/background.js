"use strict";

const PO_URLS = ["https://pocketoption.com/*", "https://*.pocketoption.com/*"];
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
async function updateMonitor(patch) {
  const current = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {};
  await chrome.storage.local.set({ [STORAGE_KEY]: { ...current, ...patch, updatedAt: Date.now() } });
}
chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === "PT_FORWARD_SIGNAL" && validSignal(message.signal)) sendToBroker({ type: "PT_SIGNAL", signal: message.signal });
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