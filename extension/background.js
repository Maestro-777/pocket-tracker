"use strict";

const PO_URLS = ["https://pocketoption.com/*", "https://*.pocketoption.com/*"];

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== "PT_FORWARD_SIGNAL" || !message.signal) return;
  const signal = message.signal;
  if (!["CALL", "PUT"].includes(signal.direction) ||
      signal.period !== 5 || signal.durationSeconds !== 15 ||
      typeof signal.id !== "string") return;

  chrome.tabs.query({ url: PO_URLS }, tabs => {
    for (const tab of tabs) {
      if (tab.id == null) continue;
      chrome.tabs.sendMessage(tab.id, { type: "PT_SIGNAL", signal }).catch(() => {});
    }
  });
});
