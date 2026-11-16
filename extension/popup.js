"use strict";
const TRACKER_URLS = ["http://127.0.0.1/*", "http://localhost/*"];
const BROKER_URLS = ["https://pocketoption.com/*", "https://*.pocketoption.com/*"];
const $ = id => document.getElementById(id);
let current = { tracker: [], broker: [] };

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
function showAccount(state) {
  const type = state?.account || "unknown";
  $("account-state").textContent = type === "demo" ? (state?.authenticated ? "DEMO · авторизация подтверждена" : "DEMO определён · авторизация НЕ подтверждена") : type === "real" ? "REAL · торговля запрещена" : "Тип счёта не определён";
  $("account-state").className = type === "demo" ? "safe" : "blocked";
  $("execution-state").textContent = type === "demo"
    ? "DEMO определён. Исполнение всё равно отключено до подтверждения протокола сделки."
    : "Fail-closed: ручные и автоматические ордера заблокированы.";
}
function showStats() {
  // The current read-only build deliberately records no trades. Never infer
  // wins/losses from signal notifications or chart movements.
  $("trades").textContent = "0";
  $("wins").textContent = "0";
  $("losses").textContent = "0";
  $("winrate").textContent = "—";
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
    current = { tracker, broker };
    setStatus("tracker", tracker.length ? "ok" : "bad", tracker.length ? "Вкладка отвечает" : "Открой локальный Pocket Tracker");
    setStatus("broker", broker.length ? "ok" : "bad", broker.length ? "Вкладка отвечает · " + broker.length : "Открой Pocket Option");
    const monitor = await getMonitor();
    const state = broker.map(x => x.reply.marketState).find(Boolean) || monitor.state || {};
    const diagnostics = state?.diagnostics || {};
    const fresh = !!(monitor.lastMarketAt && Date.now() - monitor.lastMarketAt < 15000);
    setStatus("bridge", fresh ? "ok" : "warn", `WS ${diagnostics.socketsCreated || 0}/${diagnostics.socketsOpened || 0} · IN ${diagnostics.incomingFrames || 0} · OUT ${diagnostics.outgoingFrames || 0} · последнее: ${diagnostics.lastEvent || "нет"}${diagnostics.socketHost ? " · " + diagnostics.socketHost + diagnostics.socketPath : ""}`);
    showAccount(state);
    showStats();
    $("test").disabled = broker.length === 0;
  } catch (error) {
    setStatus("bridge", "bad", "Ошибка: " + error.message);
  } finally {
    $("refresh").disabled = false;
    $("refresh").textContent = "Обновить состояние";
  }
}
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
