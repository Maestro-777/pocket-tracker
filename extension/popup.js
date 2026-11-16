"use strict";
const TRACKER_URLS = ["http://127.0.0.1/*", "http://localhost/*"];
const BROKER_URLS = ["https://pocketoption.com/*", "https://*.pocketoption.com/*"];
const $ = id => document.getElementById(id);
let current = { tracker: [], broker: [], canTrade: false, autoTrading: false };

function setStatus(name, state, message) {
  $(name + "-dot").className = "dot " + state;
  $(name + "-status").textContent = message;
}
async function pingTab(tab, inject = false) {
  if (tab.id == null) return null;
  try {
    const reply = await chrome.tabs.sendMessage(tab.id, { type: "PT_PING" });
    if (reply?.ok) return { tab, reply };
  } catch (_) {}
  if (inject) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await new Promise(r => setTimeout(r, 120));
      const reply = await chrome.tabs.sendMessage(tab.id, { type: "PT_PING" });
      if (reply?.ok) return { tab, reply };
    } catch (_) {}
  }
  return null;
}
async function getMonitor() {
  return (await chrome.storage.local.get("ptBrokerMonitor")).ptBrokerMonitor || {};
}
function showAccount(accountState, executionState) {
  const type = accountState?.account || "unknown";
  const verified = accountState?.demo_verified === true && executionState?.can_trade === true;
  $("account-state").textContent = type === "demo"
    ? (verified ? "DEMO · сервер подтвердил тип счёта" : "DEMO указан, но серверное подтверждение отсутствует")
    : type === "real" ? "REAL · торговля заблокирована" : "Тип счёта не подтверждён";
  $("account-state").className = verified ? "safe" : "blocked";
  $("execution-state").textContent = verified
    ? "Доступны ручные сделки и автоторговля только на DEMO."
    : "Fail-closed: ручные и автоматические ордера заблокированы.";
  current.canTrade = verified;
  current.autoTrading = executionState?.auto_trading === true;
  $("call-trade").disabled = !verified;
  $("put-trade").disabled = !verified;
  $("auto-toggle").disabled = !verified;
  $("auto-toggle").textContent = current.autoTrading ? "Остановить автоторговлю" : "Включить автоторговлю";
  $("auto-toggle").classList.toggle("active", current.autoTrading);
}
function showStats() {
  $("trades").textContent = "0";
  $("wins").textContent = "0";
  $("losses").textContent = "0";
  $("winrate").textContent = "—";
}
function amountValue() {
  const amount = Number($("trade-amount").value);
  if (!Number.isFinite(amount) || amount < 1 || amount > 50000) {
    $("trade-result").textContent = "Укажи сумму от 1 до 50000.";
    return null;
  }
  return amount;
}
async function refresh() {
  $("refresh").disabled = true;
  $("refresh").textContent = "Проверяем…";
  try {
    const [trackerTabs, brokerTabs] = await Promise.all([
      chrome.tabs.query({ url: TRACKER_URLS }), chrome.tabs.query({ url: BROKER_URLS })
    ]);
    const tracker = [];
    for (const tab of trackerTabs) { const x = await pingTab(tab, true); if (x) tracker.push(x); }
    const broker = [];
    for (const tab of brokerTabs) { const x = await pingTab(tab); if (x) broker.push(x); }
    current.tracker = tracker;
    current.broker = broker;
    setStatus("tracker", tracker.length ? "ok" : "bad", tracker.length ? "Вкладка отвечает" : "Открой локальный Pocket Tracker");
    setStatus("broker", broker.length ? "ok" : "warn", broker.length ? "Вкладка открыта · " + broker.length : "Вкладка сайта не обязательна для мониторинга моста");
    const monitor = await getMonitor();
    const accountState = monitor.accountState || {};
    const executionState = monitor.executionState || {};
    showAccount(accountState, executionState);
    setStatus("bridge", current.canTrade ? "ok" : "warn",
      current.canTrade ? "DEMO подтверждён · мост готов" : (accountState.account === "real" ? "REAL · заблокировано" : "Ожидание подтверждённого DEMO"));
    if (monitor.lastOrderResult) {
      const last = monitor.lastOrderResult;
      $("trade-result").textContent = last.success
        ? "Последний ордер подтверждён брокером · " + (last.direction || "")
        : (last.message || "Последний ордер не подтверждён");
    }
    showStats();
    $("test").disabled = broker.length === 0;
  } catch (error) {
    setStatus("bridge", "bad", "Ошибка: " + error.message);
  } finally {
    $("refresh").disabled = false;
    $("refresh").textContent = "Обновить состояние";
  }
}
async function manualTrade(direction) {
  const amount = amountValue();
  if (amount == null || !current.canTrade || !current.tracker.length) return;
  $("trade-result").textContent = "Передаю команду " + direction + " в локальный мост…";
  try {
    await chrome.runtime.sendMessage({ type:"PT_MANUAL_TRADE", direction, amount });
  } catch (error) {
    $("trade-result").textContent = "Не удалось передать команду: " + error.message;
  }
}
$("call-trade").addEventListener("click", () => manualTrade("CALL"));
$("put-trade").addEventListener("click", () => manualTrade("PUT"));
$("auto-toggle").addEventListener("click", async () => {
  const amount = amountValue();
  if (amount == null || !current.canTrade || !current.tracker.length) return;
  const enabled = !current.autoTrading;
  $("trade-result").textContent = enabled ? "Включаю автоторговлю…" : "Останавливаю автоторговлю…";
  try {
    await chrome.runtime.sendMessage({ type:"PT_SET_AUTO_TRADING", enabled, amount });
    current.autoTrading = enabled;
    $("auto-toggle").textContent = enabled ? "Остановить автоторговлю" : "Включить автоторговлю";
  } catch (error) {
    $("trade-result").textContent = "Не удалось изменить режим: " + error.message;
  }
});
$("refresh").addEventListener("click", refresh);
$("test").addEventListener("click", async () => {
  $("test").disabled = true;
  $("test-result").textContent = "Отправляю тест уведомления…";
  try {
    await chrome.runtime.sendMessage({ type: "PT_TEST_BROADCAST" });
    $("test-result").textContent = "Тест отправлен на вкладку Pocket Option. Сделка не открывается.";
  } catch (e) { $("test-result").textContent = "Ошибка: " + e.message; }
  $("test").disabled = current.broker.length === 0;
});
refresh();
