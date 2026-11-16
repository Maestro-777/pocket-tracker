function $(id) { return document.getElementById(id); }

async function getQuotexTabId() {
  const tabs = await chrome.tabs.query({ url: ['https://pocketoption.com/*', 'https://*.pocketoption.com/*'] });
  if (tabs && tabs.length > 0) return tabs[0].id;
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return activeTabs && activeTabs[0] ? activeTabs[0].id : null;
}

function appendLog(line) {
  const el = $('log');
  const t = new Date().toLocaleTimeString();
  el.textContent += `[${t}] ${line}\n`;
  el.scrollTop = el.scrollHeight;
}

function setRunning(isOn) {
  const st = $('status');
  st.textContent = isOn ? 'РАБОТАЕТ' : 'СТОП';
  st.classList.toggle('on', !!isOn);
  $('start').disabled = !!isOn;
  $('stop').disabled = !isOn;
}

async function loadSettings() {
  const s = await chrome.storage.local.get(null);
  if (s.indicator)  $('indicator').value  = s.indicator;
  if (s.moneyManagement) $('mm').value    = s.moneyManagement;
  if (s.baseBet)    $('baseBet').value    = s.baseBet;
  if (s.expiration) $('expiration').value = s.expiration;
}

async function saveSettings() {
  const data = {
    indicator:       $('indicator').value,
    moneyManagement: $('mm').value,
    baseBet:         parseFloat($('baseBet').value || '1'),
    expiration:      parseInt($('expiration').value || '1', 10),
  };
  await chrome.storage.local.set(data);
  return data;
}

async function startBot() {
  const tabId = await getQuotexTabId();
  if (!tabId) { appendLog('⚠️ Откройте вкладку Quotex (pocketoption.com)'); return; }
  const config = await saveSettings();
  try {
    await chrome.runtime.sendMessage({ type: 'POROBOT_START', config, tabId });
  } catch(e) { appendLog(`Ошибка: ${e.message}`); return; }
  setRunning(true);
  appendLog('▶ Бот запущен');
}

async function stopBot() {
  const tabId = await getQuotexTabId();
  try {
    await chrome.runtime.sendMessage({ type: 'POROBOT_STOP', tabId });
  } catch(e) {}
  setRunning(false);
  appendLog('⬛ Бот остановлен');
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'POROBOT_LOG')   appendLog(msg.message);
  if (msg && msg.type === 'POROBOT_STATS') appendLog(`STATS: ${JSON.stringify(msg.stats)}`);
});

(async function init() {
  await loadSettings();
  setRunning(false);
  // Open as persistent popup window
  try {
    const currentWindow = await chrome.windows.getCurrent();
    const store = await chrome.storage.local.get('panelWindowId');
    if (!store.panelWindowId || currentWindow.id !== store.panelWindowId) {
      const response = await chrome.runtime.sendMessage({ event: 'openPanel' });
      if (response === true && currentWindow.id !== store.panelWindowId) {
        setTimeout(() => { try { window.close(); } catch(_) {} }, 200);
      }
    }
  } catch(_) {}

  $('start').addEventListener('click', () => startBot().catch(e => appendLog(String(e))));
  $('stop').addEventListener('click',  () => stopBot().catch(e => appendLog(String(e))));
  appendLog('✅ Панель готова. Откройте pocketoption.com/ru/cabinet/demo-quick-high-low/');
})();
