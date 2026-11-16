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

function setStatus(name, state, message) {
  $(name + "-dot").className = "dot " + state;
  $(name + "-status").textContent = message;
}

async function pingTabs(tabs) {
  const found = [];
  for (const tab of tabs) {
    if (tab.id == null) continue;
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, { type: "PT_PING" });
      if (reply && reply.ok) found.push({ tab, reply });
    } catch (_) {}
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
  try {
    const [trackerTabs, brokerTabs] = await Promise.all([
      chrome.tabs.query({ url: TRACKER_URLS }),
      chrome.tabs.query({ url: BROKER_URLS })
    ]);
    const [tracker, broker] = await Promise.all([
      pingTabs(trackerTabs),
      pingTabs(brokerTabs)
    ]);
    current = { tracker, broker };

    setStatus("tracker", tracker.length ? "ok" : (trackerTabs.length ? "warn" : "bad"),
      tracker.length ? "Подключён · вкладка отвечает" :
      trackerTabs.length ? "Вкладка найдена, но скрипт не отвечает" : "Не найдена вкладка localhost / 127.0.0.1");
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
