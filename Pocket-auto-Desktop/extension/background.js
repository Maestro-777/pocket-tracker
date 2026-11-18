'use strict';

// Electron-compatible background adapter for the desktop test build.
// The original Windows bridge, telemetry and unsupported Chrome APIs are
// intentionally excluded from this isolated copy.

const DEFAULTS = {
  botEnabled: false,
  tradingPair: 'EUR/USD',
  indicator: 'RSI',
  moneyManagement: 'fixed',
  baseBet: 1,
  martingaleMultiplier: 2,
  parlaySteps: 2,
  expiration: 1,
  autoTrade: false,
  multiPairTrading: true,
  minProfit: 92,
  maxConcurrentTrades: 4,
  includeOtc: true,
  reverseEnabled: false,
  reverseWins: 3
};

async function ensureDefaults() {
  try {
    const current = await chrome.storage.local.get(null);
    const missing = {};
    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (current[key] === undefined) missing[key] = value;
    }
    if (Object.keys(missing).length) {
      await chrome.storage.local.set(missing);
    }
  } catch (error) {
    console.error('[Pocket Tracker Desktop] settings init failed:', error);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureDefaults();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureDefaults();
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || typeof request !== 'object') return false;

  if (request.action === 'getSettings') {
    chrome.storage.local.get(null).then(sendResponse).catch(error => {
      sendResponse({ error: String(error) });
    });
    return true;
  }

  const relayTypes = new Set([
    'POROBOT_START',
    'POROBOT_STOP',
    'POROBOT_CORE_CMD',
    'BOT_FOCUS_PAIR'
  ]);

  if (!relayTypes.has(request.type)) return false;

  const tabId = sender && sender.tab ? sender.tab.id : request.tabId;
  if (!Number.isInteger(tabId)) {
    sendResponse({ ok: false, error: 'Trading page tab was not identified.' });
    return false;
  }

  chrome.tabs.sendMessage(tabId, request).then(() => {
    sendResponse({ ok: true });
  }).catch(error => {
    sendResponse({ ok: false, error: String(error) });
  });

  return true;
});

void ensureDefaults();
