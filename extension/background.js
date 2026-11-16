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

// One-shot, user-initiated capture of the Pocket Option auth frame.
// The frame is kept in memory only, forwarded to the local Tracker tab,
// and the debugger is detached immediately. It is never written to storage/logs.
let authCaptureTabId = null;
let authCaptureTimer = null;

function parseCapturedAuthFrame(raw) {
  if (typeof raw !== "string" || !raw.startsWith('42')) return null;
  let packet;
  try { packet = JSON.parse(raw.slice(2)); } catch (_) { return null; }
  if (!Array.isArray(packet) || packet[0] !== "auth" || !packet[1] || typeof packet[1] !== "object") return null;
  const p = packet[1];
  const demo = p.isDemo === true || p.isDemo === 1 || String(p.isDemo).toLowerCase() === "true" || String(p.isDemo) === "1";
  if (!demo || typeof p.session !== "string" || !p.session.trim() || !Number.isInteger(Number(p.uid))) return { realOrInvalid: true };
  return { frame: raw };
}

async function finishAuthCapture(status, frame, tabId) {
  if (authCaptureTimer) clearTimeout(authCaptureTimer);
  authCaptureTimer = null;
  const targetId = authCaptureTabId;
  authCaptureTabId = null;
  if (targetId != null) {
    try { await chrome.debugger.detach({ tabId: targetId }); } catch (_) {}
  }
  if (frame) {
    const trackers = await chrome.tabs.query({ url: TRACKER_URLS });
    let delivered = false;
    for (const tab of trackers) {
      if (tab.id == null) continue;
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "PT_AUTH_FRAME", authFrame: frame });
        delivered = true;
        break;
      } catch (_) {}
    }
    status = delivered
      ? "DEMO-авторизация передана локальному мосту. Ожидаю подтверждение брокера."
      : "Кадр DEMO получен, но вкладка Pocket Tracker не найдена. Открой Tracker и повтори подключение.";
  }
  await updateMonitor({ authCaptureStatus: status });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null || source.tabId !== authCaptureTabId || method !== "Network.webSocketFrameSent") return;
  const raw = params?.response?.payloadData;
  const parsed = parseCapturedAuthFrame(raw);
  if (!parsed) return;
  if (parsed.realOrInvalid) {
    finishAuthCapture("Обнаружен не-DEMO или некорректный кадр. Он не передан мосту; переключи Pocket Option на DEMO и повтори.", null, source.tabId);
    return;
  }
  finishAuthCapture("Кадр DEMO получен.", parsed.frame, source.tabId);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== authCaptureTabId) return;
  finishAuthCapture("Захват прерван браузером: " + reason + ". Повтори попытку.", null, source.tabId);
});

async function startAuthCapture(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("Не найдена вкладка Pocket Option.");
  if (authCaptureTabId != null) await finishAuthCapture("Предыдущий захват остановлен.", null, authCaptureTabId);
  authCaptureTabId = tabId;
  await updateMonitor({ authCaptureStatus: "Захват включён на 25 секунд. Обнови вкладку Pocket Option, чтобы она повторно отправила auth-кадр." });
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error("Не удалось подключить отладчик: " + err.message + ". Закрой DevTools для этой вкладки и повтори."));
      else resolve();
    });
  }).catch(async error => {
    authCaptureTabId = null;
    await updateMonitor({ authCaptureStatus: error.message });
    throw error;
  });
  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, "Network.enable", {}, () => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve();
      });
    });
  } catch (error) {
    await finishAuthCapture("Не удалось включить мониторинг WebSocket: " + error.message, null, tabId);
    throw error;
  }
  authCaptureTimer = setTimeout(() => {
    finishAuthCapture("За 25 секунд auth-кадр не получен. Нажми захват и сразу обнови вкладку Pocket Option.", null, tabId);
  }, 25000);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;
  if (message.type === "PT_CAPTURE_AUTH") {
    startAuthCapture(message.tabId).then(() => sendResponse?.({ ok: true }))
      .catch(error => sendResponse?.({ ok: false, error: error.message }));
    return true;
  }
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