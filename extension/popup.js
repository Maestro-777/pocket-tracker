"use strict";
const TRACKER_URLS = ["http://127.0.0.1/*", "http://localhost/*"];
const BROKER_URLS = ["https://pocketoption.com/*", "https://*.pocketoption.com/*"];
const $ = id => document.getElementById(id);
let current = { tracker: [], broker: [], canTrade: false, canAutoTrade: false, autoTrading: false };

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
  const accountVerified = accountState?.demo_verified === true && current.tracker.length > 0;
  const manualReady = accountVerified && executionState?.can_trade === true;
  current.autoTrading = executionState?.auto_trading === true;
  const autoReady = accountVerified && (executionState?.can_auto_trade === true || current.autoTrading);
  $("account-state").textContent = type === "demo"
    ? (accountVerified ? "DEMO · сервер подтвердил тип счёта" : "DEMO указан, но серверное подтверждение отсутствует")
    : type === "real" ? "REAL · торговля заблокирована" : "Тип счёта не подтверждён";
  $("account-state").className = accountVerified ? "safe" : "blocked";
  $("execution-state").textContent = !accountVerified
    ? "Fail-closed: ручные и автоматические ордера заблокированы."
    : current.autoTrading
      ? "Автоторговля включена · можно остановить в любой момент."
      : manualReady && executionState?.can_auto_trade === true
        ? "Ручные сделки и автоторговля доступны на DEMO."
        : manualReady
          ? "Ручные сделки доступны · для автоторговли выбери таймфрейм 5 секунд."
          : "Ожидание свежих котировок или закрытия открытой сделки.";
  current.canTrade = manualReady;
  current.canAutoTrade = autoReady;
  $("call-trade").disabled = !manualReady;
  $("put-trade").disabled = !manualReady;
  $("auto-toggle").disabled = !autoReady;
  $("auto-toggle").textContent = current.autoTrading ? "Остановить автоторговлю" : "Включить автоторговлю";
  $("auto-toggle").classList.toggle("active", current.autoTrading);
}
function amountValue() {
  const amount = Number($("trade-amount").value);
  if (!Number.isFinite(amount) || amount < 1 || amount > 50000) {
    $("trade-result").textContent = "Укажи сумму от 1 до 50000.";
    return null;
  }
  return amount;
}
async function captureAuth() {
  const button = $("capture-auth");
  button.disabled = true;
  $("capture-status").textContent = "Подготавливаю одноразовый захват. После запуска обнови вкладку Pocket Option.";
  try {
    const tabs = await chrome.tabs.query({ url: BROKER_URLS });
    if (!tabs.length) throw new Error("Сначала открой вкладку Pocket Option и войди в DEMO.");
    let tab = tabs.find(item => item.active) || tabs[0];
    const result = await chrome.runtime.sendMessage({ type:"PT_CAPTURE_AUTH", tabId:tab.id });
    if (!result?.ok) throw new Error(result?.error || "Не удалось начать захват.");
    $("capture-status").textContent = "Захват активен 25 секунд. Теперь обнови вкладку Pocket Option (F5). DevTools должны быть закрыты.";
  } catch (error) {
    $("capture-status").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}
$("capture-auth").addEventListener("click", captureAuth);

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
    $("capture-status").textContent = monitor.authCaptureStatus || "Кадр сессии не сохраняется; захват запускается только по кнопке.";
    const accountState = monitor.accountState || {};
    const executionState = monitor.executionState || {};
    showAccount(accountState, executionState);
    if (monitor.lastSignal) {
      const signal = monitor.lastSignal;
      const node = $("last-signal");
      node.textContent = signal.direction + " · " + (signal.asset || "инструмент") +
        " · RSI " + Number(signal.rsi).toFixed(1);
      node.className = String(signal.direction).toLowerCase();
      $("last-signal-time").textContent = "Свеча: " + new Date(Number(signal.createdAt || Number(signal.candleTime) * 1000)).toLocaleTimeString();
    } else {
      $("last-signal").textContent = "Пока сигналов нет";
      $("last-signal").className = "";
      $("last-signal-time").textContent = "Ожидание закрытой свечи";
    }
    setStatus("bridge", current.canTrade ? "ok" : "warn",
      current.canTrade ? "DEMO подтверждён · мост готов" : (accountState.account === "real" ? "REAL · заблокировано" : "Ожидание подтверждённого DEMO"));
    if (monitor.lastOrderResult) {
      const last = monitor.lastOrderResult;
      $("trade-result").textContent = last.success
        ? "Последний ордер подтверждён брокером · " + (last.direction || "")
        : (last.message || "Последний ордер не подтверждён");
    }
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
  if (amount == null || !current.canAutoTrade || !current.tracker.length) return;
  const enabled = !current.autoTrading;
  $("trade-result").textContent = enabled ? "Включаю автоторговлю…" : "Останавливаю автоторговлю…";
  try {
    await chrome.runtime.sendMessage({ type:"PT_SET_AUTO_TRADING", enabled, amount });
    $("trade-result").textContent = "Команда передана · ожидаю подтверждения локального моста.";
  } catch (error) {
    $("trade-result").textContent = "Не удалось изменить режим: " + error.message;
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.ptBrokerMonitor?.newValue) return;
  const monitor = changes.ptBrokerMonitor.newValue;
  if (monitor.accountState || monitor.executionState) {
    showAccount(monitor.accountState || {}, monitor.executionState || {});
  }
  if (monitor.lastSignal) {
    const signal = monitor.lastSignal;
    const node = $("last-signal");
    node.textContent = signal.direction + " · " + (signal.asset || "инструмент") +
      " · RSI " + Number(signal.rsi).toFixed(1);
    node.className = String(signal.direction).toLowerCase();
    $("last-signal-time").textContent = "Сигнал: " + new Date(Number(signal.createdAt || Number(signal.candleTime) * 1000)).toLocaleTimeString();
  }
  if (monitor.lastOrderResult) {
    const last = monitor.lastOrderResult;
    $("trade-result").textContent = last.success
      ? "Брокер подтвердил открытие " + (last.direction || "")
      : (last.message || "Последний ордер не подтверждён");
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
