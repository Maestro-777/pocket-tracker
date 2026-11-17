function $(id) { return document.getElementById(id); }
let accountState = { mode: 'unknown' };
async function getQuotexTabId() {
  const tabs = await chrome.tabs.query({ url: ['https://pocketoption.com/*', 'https://*.pocketoption.com/*'] });
  return tabs && tabs.length ? tabs[0].id : null;
}
function appendLog(line) { const el=$('log'); el.textContent += '['+new Date().toLocaleTimeString()+'] '+line+'\\n'; el.scrollTop=el.scrollHeight; }
function setRunning(on) { const st=$('status'); st.textContent=on?'РАБОТАЕТ':'СТОП'; st.classList.toggle('on',!!on); $('start').disabled=!!on; $('stop').disabled=!on; }
function renderAccount(payload) {
  accountState = payload || {mode:'unknown'};
  const mode = accountState.mode || 'unknown';
  const el=$('accountMode'), hint=$('accountHint');
  el.className='mode '+mode;
  el.textContent=mode==='demo'?'DEMO · ДЕМО-СЧЁТ':mode==='real'?'REAL · РЕАЛЬНЫЙ СЧЁТ':'НЕ ОПРЕДЕЛЁН';
  hint.textContent=mode==='demo'?'Обнаружен демонстрационный счёт.':mode==='real'?'Обнаружен реальный счёт. Запуск требует отдельного подтверждения.':'Режим счёта не подтверждён. Автоторговля из этой панели заблокирована.';
}
async function loadSettings() {
  const s=await chrome.storage.local.get(null);
  if(s.indicator)$('indicator').value=s.indicator;
  if(s.moneyManagement)$('mm').value=s.moneyManagement;
  if(s.baseBet)$('baseBet').value=s.baseBet;
  if(s.expiration)$('expiration').value=s.expiration;
  $('autoTrade').checked = !!s.autoTrade;
  $('multiPairTrading').checked = s.multiPairTrading !== false;
  $('minProfit').value = s.minProfit != null ? s.minProfit : 92;
  $('maxConcurrentTrades').value = s.maxConcurrentTrades != null ? s.maxConcurrentTrades : 4;
  $('includeOtc').checked = s.includeOtc !== false;
  $('reverseEnabled').checked = !!s.reverseEnabled;
  $('reverseWins').value = s.reverseWins != null ? Math.max(1, Math.min(10, parseInt(s.reverseWins, 10) || 3)) : 3;
  $('reverseWinsValue').textContent = $('reverseWins').value;
}
async function saveSettings() {
  const minProfit = Number($('minProfit').value);
  const maxConcurrentTrades = Number($('maxConcurrentTrades').value);
  const data={
    indicator:$('indicator').value,
    moneyManagement:$('mm').value,
    baseBet:parseFloat($('baseBet').value||'1'),
    expiration:parseInt($('expiration').value||'1',10),
    autoTrade:$('autoTrade').checked,
    multiPairTrading:$('multiPairTrading').checked,
    minProfit:Number.isFinite(minProfit)?Math.max(0,Math.min(100,minProfit)):92,
    maxConcurrentTrades:Number.isFinite(maxConcurrentTrades)?Math.max(1,Math.min(20,Math.round(maxConcurrentTrades))):4,
    includeOtc:$('includeOtc').checked,
    reverseEnabled:$('reverseEnabled').checked,
    reverseWins:Math.max(1,Math.min(10,parseInt($('reverseWins').value||'3',10)))
  };
  await chrome.storage.local.set(data);
  return data;
}
async function refreshAccount() {
  const tabId=await getQuotexTabId(); if(!tabId)return;
  try { const state=await chrome.tabs.sendMessage(tabId,{type:'PT4_GET_ACCOUNT_MODE'}); if(state)renderAccount(state); }
  catch(_) { renderAccount({mode:'unknown'}); }
}
async function startBot() {
  const tabId=await getQuotexTabId();
  if(!tabId){appendLog('Откройте вкладку Pocket Option.');return;}
  if(!['demo','real'].includes(accountState.mode)){appendLog('Запуск заблокирован: тип счёта не определён.');return;}
  if(accountState.mode==='real'&&!window.confirm('Обнаружен REAL-счёт. Это реальные финансовые операции. Продолжить запуск автоторговли?'))return;
  const config=await saveSettings(); config.accountMode=accountState.mode; config.realTradeConfirmed=accountState.mode==='real';
  try { await chrome.runtime.sendMessage({type:'POROBOT_START',config,tabId}); setRunning(true); appendLog('Бот запущен · '+accountState.mode.toUpperCase()); }
  catch(e){appendLog('Ошибка: '+e.message);}
}
async function stopBot() { const tabId=await getQuotexTabId(); try{await chrome.runtime.sendMessage({type:'POROBOT_STOP',tabId});}catch(_){} setRunning(false); appendLog('Бот остановлен'); }
chrome.runtime.onMessage.addListener(msg=>{if(msg?.type==='POROBOT_LOG')appendLog(msg.message);if(msg?.type==='POROBOT_STATS')appendLog('STATS: '+JSON.stringify(msg.stats));if(msg?.type==='PT4_ACCOUNT_MODE')renderAccount(msg.payload);});
(async function init(){await loadSettings();setRunning(false);renderAccount({mode:'unknown'});await refreshAccount();$('start').addEventListener('click',()=>startBot().catch(e=>appendLog(String(e))));$('stop').addEventListener('click',()=>stopBot().catch(e=>appendLog(String(e))));$('reverseWins').addEventListener('input',()=>{$('reverseWinsValue').textContent=$('reverseWins').value;});setInterval(refreshAccount,2500);appendLog('Панель готова. Определение счёта выполняется автоматически.');})();