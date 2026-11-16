"use strict";
const $ = id => document.getElementById(id);
let currentTabId = null;
let lastConfigKey = "";
let refreshBusy = false;
async function getTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || !tab.id) throw new Error("Не найдена активная вкладка.");
  const url = String(tab.url || "");
  if (!/^https:\/\/(www\.)?pocketoption\.com\//i.test(url) &&
      !/^https:\/\/[^/]+\.pocketoption\.com\//i.test(url) &&
      !/^https:\/\/p\.finance\//i.test(url)) throw new Error("Открой торговую вкладку Pocket Option.");
  currentTabId = tab.id;
  return tab;
}
async function command(type, extra) {
  const tab = await getTab();
  return chrome.tabs.sendMessage(tab.id, Object.assign({ type:type }, extra || {}));
}
function setAccountBadge(state) {
  const mode = state.accountMode || "unknown";
  const badge = $("accountBadge");
  badge.className = "badge " + (mode === "demo" && state.demoVerified ? "demo" : mode === "real" ? "real" : "unknown");
  badge.textContent = mode === "real" ? "REAL · ЗАБЛОКИРОВАН" : (state.demoVerified ? "DEMO · ПОДТВЕРЖДЁН" : "СЧЁТ НЕ ПОДТВЕРЖДЁН");
}
function renderJournal(rows) {
  const root = $("journal"); root.textContent = "";
  if (!Array.isArray(rows) || !rows.length) {
    const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = "Пока нет событий."; root.appendChild(empty); return;
  }
  for (const item of rows.slice(0,12)) {
    const line = document.createElement("div"); line.className = "journal-item";
    const time = document.createElement("time"); time.textContent = item.time || "";
    const span = document.createElement("span"); span.textContent = item.text || "";
    line.append(time,span); root.appendChild(line);
  }
}
function populateAssets(assets) {
  const list = $("assetOptions"), seen = new Set(); list.textContent = "";
  for (const item of (assets || [])) {
    if (!item || !item.symbol || seen.has(item.symbol)) continue;
    seen.add(item.symbol);
    const option = document.createElement("option"); option.value = item.symbol; option.label = item.label || item.symbol; list.appendChild(option);
  }
}
function fillConfig(config) {
  if (!config) return;
  const key = JSON.stringify(config);
  if (key === lastConfigKey || (document.activeElement && document.activeElement.tagName === "INPUT")) return;
  lastConfigKey = key;
  $("assetInput").value = config.asset || "AUTO";
  $("amountInput").value = config.amount ?? 1;
  $("distanceInput").value = config.maxDistancePoints ?? 1;
  $("bbPeriodInput").value = config.bbPeriod ?? 20;
  $("bbDeviationInput").value = config.bbDeviation ?? 2;
  $("rsiPeriodInput").value = config.rsiPeriod ?? 14;
  $("putMinInput").value = config.putRsiMin ?? 77;
  $("putMaxInput").value = config.putRsiMax ?? 83;
  $("callMinInput").value = config.callRsiMin ?? 18;
  $("callMaxInput").value = config.callRsiMax ?? 23;
}
function render(state) {
  setAccountBadge(state);
  $("connectionLamp").classList.toggle("on", Boolean(state.connected && state.demoVerified));
  $("socketCount").textContent = "WS: " + Number(state.socketCount || 0);
  $("statusText").textContent = state.status || "Ожидание состояния.";
  $("assetValue").textContent = state.asset || "—";
  $("priceValue").textContent = state.quote == null ? "—" : Number(state.quote).toFixed(6);
  $("candleValue").textContent = String(state.candleCount || 0);
  $("rsiValue").textContent = state.rsi == null ? "—" : Number(state.rsi).toFixed(1);
  $("bbValue").textContent = "BB: " + (state.bbUpper == null ? "—" : Number(state.bbUpper).toFixed(6)) + " / " +
    (state.bbLower == null ? "—" : Number(state.bbLower).toFixed(6));
  $("historyValue").textContent = "История: " + Number(state.historyRows || 0);
  const signal = state.lastSignal;
  $("signalValue").textContent = signal ? signal.direction : "Ожидание сигнала";
  $("signalValue").className = "signal-value " + (signal ? signal.direction.toLowerCase() : "");
  $("signalMeta").textContent = signal ?
    signal.asset + " · RSI " + Number(signal.rsi).toFixed(1) + " · " + new Date(signal.createdAt).toLocaleTimeString() :
    "Проверка по закрытию свечи 5 секунд · экспирация 15 секунд";
  $("signalToggle").checked = Boolean(state.signalEnabled);
  $("autoToggle").checked = Boolean(state.autoTrading);
  $("tradeStatus").textContent = state.executionUncertain ? "Неопределённый ордер: повтор заблокирован до ответа брокера." :
    state.orderPending ? "Ожидание подтверждения брокера…" :
    state.activeOrder ? "Есть открытая сделка. Новые заявки заблокированы." :
    state.demoVerified ? "DEMO подтверждён. Доступны ручные и автоматические сделки." :
    "Сделки заблокированы до подтверждения DEMO.";
  $("checkOrderStatus").style.display = state.executionUncertain ? "block" : "none";
  const canTrade = Boolean(state.demoVerified && state.connected && !state.orderPending &&
    !state.activeOrder && !state.executionUncertain && state.lastTickAt && Date.now()-state.lastTickAt < 10000);
  $("callButton").disabled = !canTrade; $("putButton").disabled = !canTrade;
  $("autoToggle").disabled = !state.demoVerified || !state.signalEnabled || state.accountMode === "real";
  $("subscribe").disabled = !state.demoVerified || state.accountMode === "real";
  fillConfig(state.config); populateAssets(state.assets); renderJournal(state.journal);
}
async function refresh() {
  if (refreshBusy) return; refreshBusy = true;
  try { const state = await command("PT_GET_STATE"); render(state); }
  catch (error) {
    $("statusText").textContent = error && error.message ? error.message : "Расширение не подключено к этой вкладке. Обнови страницу Pocket Option.";
    $("connectionLamp").classList.remove("on"); $("callButton").disabled = true; $("putButton").disabled = true;
    $("autoToggle").disabled = true; $("subscribe").disabled = true;
  } finally { refreshBusy = false; }
}
function configFromForm() {
  return {
    asset: $("assetInput").value.trim() || "AUTO",
    amount: Number($("amountInput").value),
    maxDistancePoints: Number($("distanceInput").value),
    bbPeriod: Number($("bbPeriodInput").value),
    bbDeviation: Number($("bbDeviationInput").value),
    rsiPeriod: Number($("rsiPeriodInput").value),
    putRsiMin: Number($("putMinInput").value), putRsiMax: Number($("putMaxInput").value),
    callRsiMin: Number($("callMinInput").value), callRsiMax: Number($("callMaxInput").value)
  };
}
$("saveConfig").addEventListener("click", async function() {
  try {
    const result = await command("PT_SET_CONFIG", { patch:configFromForm() });
    if (!result || result.ok === false) throw new Error(result && result.message || "Не удалось сохранить настройки.");
    lastConfigKey = ""; await refresh();
  } catch (error) { $("statusText").textContent = error.message || String(error); }
});
$("subscribe").addEventListener("click", async function() {
  try {
    const asset = $("assetInput").value.trim() || "AUTO";
    await command("PT_SET_CONFIG", { patch:{asset:asset} });
    const result = await command("PT_SUBSCRIBE");
    if (result && result.ok === false) throw new Error(result.message || "Не удалось подписаться.");
    if (result && result.message) $("statusText").textContent = result.message;
    lastConfigKey = ""; await refresh();
  } catch (error) { $("statusText").textContent = error.message || String(error); }
});
$("signalToggle").addEventListener("change", async function(event) {
  try {
    const result = await command("PT_SET_SIGNAL", { enabled:event.target.checked });
    if (result && result.ok === false) throw new Error(result.message || "Не удалось включить поиск сигналов.");
    await refresh();
  }
  catch (error) { event.target.checked = false; $("statusText").textContent = error.message || String(error); }
});
$("autoToggle").addEventListener("change", async function(event) {
  try {
    const result = await command("PT_SET_AUTO", { enabled:event.target.checked });
    if (result && result.ok === false) throw new Error(result.message || "Не удалось включить автоторговлю.");
    await refresh();
  }
  catch (error) { event.target.checked = false; $("statusText").textContent = error.message || String(error); }
});
$("callButton").addEventListener("click", async function() {
  try {
    const result = await command("PT_MANUAL_TRADE", { direction:"CALL" });
    if (result && result.ok === false) throw new Error(result.message || "CALL не отправлен.");
    await refresh();
  }
  catch (error) { $("statusText").textContent = error.message || String(error); }
});
$("putButton").addEventListener("click", async function() {
  try {
    const result = await command("PT_MANUAL_TRADE", { direction:"PUT" });
    if (result && result.ok === false) throw new Error(result.message || "PUT не отправлен.");
    await refresh();
  }
  catch (error) { $("statusText").textContent = error.message || String(error); }
});
chrome.runtime.onMessage.addListener(function(message) { if (message && message.type === "PT_STATE_CHANGED") refresh(); });
refresh(); setInterval(refresh,1100);
