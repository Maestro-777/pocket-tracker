"use strict";

const PO_URLS = ["https://pocketoption.com/*", "https://*.pocketoption.com/*"];

function validSignal(signal) {
  return signal && ["CALL", "PUT"].includes(signal.direction) &&
    signal.period === 5 && signal.durationSeconds === 15 &&
    typeof signal.id === "string";
}

function sendToBroker(message) {
  chrome.tabs.query({ url: PO_URLS }, tabs => {
    for (const tab of tabs) {
      if (tab.id == null) continue;
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message) return;
  if (message.type === "PT_FORWARD_SIGNAL" && validSignal(message.signal)) {
    sendToBroker({ type: "PT_SIGNAL", signal: message.signal });
  }
  if (message.type === "PT_TEST_BROADCAST") {
    const signal = {
      id: "test-" + Date.now(),
      asset: "ТЕСТОВОЕ УВЕДОМЛЕНИЕ",
      period: 5,
      durationSeconds: 15,
      direction: "CALL",
      entryPrice: 1.23456,
      rsi: 20,
      distancePoints: 0.5,
      test: true,
      createdAt: Date.now()
    };
    sendToBroker({ type: "PT_TEST_SIGNAL", signal });
  }
});
