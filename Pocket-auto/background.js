// Background Service Worker for PocketOption Signal
// Мост с Windows-приложением (bridge/bridge-client.js). В Chrome SW подключаем через importScripts,
// в Firefox он уже загружен отдельным скриптом из manifest-firefox.json (background.scripts).
if (typeof importScripts === "function") {
    try { importScripts("bridge/bridge-client.js"); } catch (e) { console.error("[PocketOption Signal][BG] bridge load failed", e); }
}
console.log("PocketOption Signal: Background Service Worker initialized.");

chrome.runtime.onInstalled.addListener(() => {
    console.log("PocketOption Signal Installed.");
    chrome.storage.local.set({
        botEnabled: false,
        tradingPair: "EUR/USD",
        indicator: "RSI",
        moneyManagement: "fixed",
        baseBet: 1,
        martingaleMultiplier: 2,
        parlaySteps: 2
    });
});

async function openQuotexTab() {
    const QUOTEX_URL = 'https://pocketoption.com/ru/cabinet/demo-quick-high-low/';
    try {
        const tabs = await chrome.tabs.query({ url: ['https://pocketoption.com/*', 'https://*.pocketoption.com/*'] });
        if (tabs.length > 0) {
            await chrome.tabs.update(tabs[0].id, { active: true });
            await chrome.windows.update(tabs[0].windowId, { focused: true });
            console.log('[PocketOption Signal][BG] focused existing trade tab');
        } else {
            await chrome.tabs.create({ url: QUOTEX_URL });
            console.log('[PocketOption Signal][BG] opened new trade tab');
        }
    } catch (e) {
        console.error('[PocketOption Signal][BG] openTradeTab failed', e);
    }
}

chrome.action.onClicked.addListener(() => {
    openQuotexTab();
});

// ── Маркет пресетов (market/ext-host.js → сюда → POST /api/market.php) ─────────────
// Как Market/MarketService.cs приложения: whitelist действий, токен добавляет background (страница его не видит).
// Токен маркета (JWS typ POS-MKT, 30 дней) выдаёт action=login по email + паролю аккаунта; хранится в storage.local.
// Протокол — Windows/ARCHITECTURE.md §15–16, §18.
const MARKET_URL = 'https://pocketoption-signal.online/api/market.php';
const MARKET_AUTH_KEY = 'posMarketAuth';
const MARKET_PUBLIC = ['catalog', 'get'];
const MARKET_PRIVATE = ['my', 'profile', 'save', 'update', 'delete', 'publish', 'unpublish',
    'install', 'uninstall', 'buy', 'invoice', 'invoice_tx'];
const MARKET_DROP_TOKEN = ['invalid_token', 'device_removed'];

function marketError(error, status) { return { ok: false, error, status }; }

async function marketAuth() {
    try {
        const s = await chrome.storage.local.get(MARKET_AUTH_KEY);
        const a = s[MARKET_AUTH_KEY];
        if (!a || !a.token) return null;
        if (a.exp && a.exp * 1000 <= Date.now()) { await chrome.storage.local.remove(MARKET_AUTH_KEY); return null; }
        return a;
    } catch (_) { return null; }
}

async function marketPost(body) {
    const json = JSON.stringify(body);
    if (json.length > 16000) return marketError('bad_request', 400);
    try {
        // text/plain — простой запрос, без CORS preflight (сервер принимает JSON в любом Content-Type)
        const resp = await fetch(MARKET_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: json, cache: 'no-store' });
        let data = null;
        try { data = await resp.json(); } catch (_) { /* не JSON — ошибка хостинга */ }
        if (!data || typeof data !== 'object' || Array.isArray(data)) data = marketError('http_' + resp.status, resp.status);
        data.status = resp.status;
        return data;
    } catch (_) {
        return marketError('network', 0);
    }
}

async function marketCall(action, params) {
    if (!MARKET_PUBLIC.includes(action) && !MARKET_PRIVATE.includes(action)) return marketError('bad_request', 400);
    const body = Object.assign({}, params && typeof params === 'object' ? params : {}, { action });
    delete body.token; delete body.email; delete body.password;
    const auth = await marketAuth();
    if (!auth && MARKET_PRIVATE.includes(action)) return marketError('auth_required', 401);
    if (auth) body.token = auth.token;
    const r = await marketPost(body);
    if (auth && MARKET_DROP_TOKEN.includes(r.error)) {
        // пароль сменён, аккаунт заблокирован или токен испорчен — нужен новый вход
        try { await chrome.storage.local.remove(MARKET_AUTH_KEY); } catch (_) {}
    }
    return r;
}

function browserLabel() {
    const ua = (self.navigator && navigator.userAgent) || '';
    const m = /(YaBrowser|Edg|OPR|Firefox|Chrome)\/(\d+)/.exec(ua);
    const names = { YaBrowser: 'Yandex', Edg: 'Edge', OPR: 'Opera', Firefox: 'Firefox', Chrome: 'Chrome' };
    return 'Extension ' + chrome.runtime.getManifest().version + (m ? ' · ' + names[m[1]] + ' ' + m[2] : '');
}

async function marketLogin(req) {
    const email = String(req.email || '').trim();
    const password = String(req.password || '');
    if (!email || !password) return marketError('bad_request', 400);
    const body = { action: 'login', email, password, client: browserLabel(), lang: req.lang === 'en' ? 'en' : 'ru' };
    const totp = String(req.totp || '').replace(/\s+/g, '');
    if (totp) body.totp = totp;
    const r = await marketPost(body);
    if (!r.ok || !r.token) return r.ok ? marketError('server_error', 500) : r;
    const account = r.account || { email };
    await chrome.storage.local.set({ [MARKET_AUTH_KEY]: { token: r.token, exp: r.token_exp || 0, email: account.email || email } });
    return { ok: true, account };
}

function handleMarketMessage(request, sendResponse) {
    let p;
    if (request.type === 'POS_MARKET') p = marketCall(String(request.action || ''), request.params);
    else if (request.type === 'POS_MARKET_LOGIN') p = marketLogin(request);
    else if (request.type === 'POS_MARKET_LOGOUT') p = chrome.storage.local.remove(MARKET_AUTH_KEY).then(() => ({ ok: true }));
    else p = marketAuth().then((a) => ({ email: a ? a.email : null }));
    p.then(sendResponse, () => sendResponse(marketError('network', 0)));
    return true;
}

// Listener for messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request && typeof request.type === 'string' && request.type.indexOf('POS_MARKET') === 0) {
        // только наши content scripts (страница сюда писать не может, но проверим отправителя)
        if (sender.id !== chrome.runtime.id) return false;
        return handleMarketMessage(request, sendResponse);
    }

    if (request.action === "getSettings") {
        chrome.storage.local.get(null, (data) => {
            sendResponse(data);
        });
        return true;
    }

    // RELAY: Broadcast messages to all frames in the specified tab (from panel / UI)
    if (request.type === 'POROBOT_START' || request.type === 'POROBOT_STOP' || request.type === 'POROBOT_CORE_CMD' || request.type === 'BOT_FOCUS_PAIR') {
        const targetTabId = request.tabId || (sender.tab && sender.tab.id);
        if (targetTabId) {
            chrome.tabs.sendMessage(targetTabId, request).catch(e => {
                console.error('[PocketOption Signal][BG] relay failed', e);
            });
        } else {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0]) {
                    chrome.tabs.sendMessage(tabs[0].id, request);
                }
            });
        }
    }

    // Panel window management
    if (request.event === 'openPanel') {
        chrome.storage.local.get('panelWindowId', async (store) => {
            const existingId = store.panelWindowId;
            if (existingId) {
                try {
                    const win = await chrome.windows.get(existingId);
                    if (win) {
                        chrome.windows.update(existingId, { focused: true });
                        sendResponse(true);
                        return;
                    }
                } catch (_) {}
            }
            const panelUrl = chrome.runtime.getURL('panel/panel.html');
            const win = await chrome.windows.create({
                url: panelUrl,
                type: 'popup',
                width: 402,
                height: 860,
                focused: true
            });
            chrome.storage.local.set({ panelWindowId: win.id });
            sendResponse(true);
        });
        return true;
    }
});
