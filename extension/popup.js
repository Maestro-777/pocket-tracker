"use strict";

const TRACKER_URLS = [
  "http://127.0.0.1/*",
  "http://localhost/*"
];
const BROKER_URLS = [
  "https://pocketoption.com/*",
  "https://*.pocketoption.com/*"
];

const $ = id => document.getElementById(id);
let current = { tracker: [], broker: [] };
let trackerDiagnostic = "";

function setStatus(name, state, message) {
  $(name + "-dot").className = "dot " + state;
  $(name + "-status").textContent = message;
}

async function pingTab(tab, allowInjection = false) {
  if (tab.id == null) return null;
  try {
    const reply = await chrome.tabs.sendMessage(tab.id, { type: "PT_PING" });
    if (reply && reply.ok) return { tab, reply };
  } catch (error) {
    trackerDiagnostic = error && error.message ? error.message : String(error);
  }

  // If the static content script was not injected (for example, the extension
  // was updated while the tab remained open), inject it once and retry.
  if (allowInjection) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"]
      });
      await new Promise(resolve => setTimeout(resolve, 150));
      const reply = await chrome.tabs.sendMessage(tab.id, { type: "PT_PING" });
      if (reply && reply.ok) return { tab, reply, injected: true };
    } catch (error) {
      trackerDiagnostic = error && error.message ? error.message : String(error);
    }
  }
  return null;
}

async function pingTabs(tabs, allowInjection = false) {
  const found = [];
  for (const tab of tabs) {
    const result = await pingTab(tab, allowInjection);
    if (result) found.push(result);
  }
  return found;
}

function showLastSignal(brokerResults) {
  const latest = brokerResults
    .map(item => item.reply.lastSignal)
    .filter(Boolean)
    .sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0))[0];
  const el = $("last-signal");
  if (!latest) {
    el.className = "last-empty";
    el.textContent = "Пока сигналов нет";
    return;
  }
  el.className = "last-signal";
  el.textContent = (latest.test ? "Тест доставки · " : "Получен сигнал · ") +
    latest.direction + " · " + latest.asset + " · RSI " +
    Number(latest.rsi).toFixed(1) + " · " +
    new Date(latest.receivedAt).toLocaleTimeString();
}

async function refresh() {
  $("refresh").disabled = true;
  $("refresh").textContent = "Проверяем…";
  trackerDiagnostic = "";
  try {
    const [trackerTabs, brokerTabs] = await Promise.all([
      chrome.tabs.query({ url: TRACKER_URLS }),
      chrome.tabs.query({ url: BROKER_URLS })
    ]);
    // Try normal messaging first, then inject the content script only into
    // matching local Tracker tabs that did not answer.
    const tracker = await pingTabs(trackerTabs, true);
    const broker = await pingTabs(brokerTabs);
    current = { tracker, broker };

    setStatus("tracker", tracker.length ? "ok" : (trackerTabs.length ? "warn" : "bad"),
      tracker.length
        ? "Подключён · вкладка отвечает" + (tracker.some(item => item.injected) ? " (скрипт восстановлен)" : "")
        : trackerTabs.length
          ? "Вкладка найдена, скрипт не запустился: " + (trackerDiagnostic || "нет ответа")
          : "Не найдена вкладка localhost / 127.0.0.1");
    setStatus("broker", broker.length ? "ok" : (brokerTabs.length ? "warn" : "bad"),
      broker.length ? "Подключён · " + broker.length + " вкладка(и)" :
      brokerTabs.length ? "Вкладка найдена, но скрипт не отвечает" : "Открой сайт Pocket Option");
    const both = tracker.length > 0 && broker.length > 0;
    setStatus("bridge", both ? "ok" : "warn",
      both ? "Оба конца связи доступны" : "Нужны обе подключённые вкладки");
    $("test").disabled = broker.length === 0;
    showLastSignal(broker);
  } catch (error) {
    setStatus("bridge", "bad", "Ошибка проверки: " + error.message);
  } finally {
    $("refresh").disabled = false;
    $("refresh").textContent = "Проверить подключение";
  }
}

$("refresh").addEventListener("click", refresh);
$("test").addEventListener("click", async () => {
  $("test").disabled = true;
  $("test-result").textContent = "Отправляем тестовое уведомление…";
  try {
    await chrome.runtime.sendMessage({ type: "PT_TEST_BROADCAST" });
    $("test-result").textContent =
      "Тест отправлен. На вкладке Pocket Option должна появиться плашка «Тестовое уведомление». Сделка не открывается.";
    setTimeout(refresh, 500);
  } catch (error) {
    $("test-result").textContent = "Не удалось отправить тест: " + error.message;
  } finally {
    $("test").disabled = current.broker.length === 0;
  }
});

refresh();
