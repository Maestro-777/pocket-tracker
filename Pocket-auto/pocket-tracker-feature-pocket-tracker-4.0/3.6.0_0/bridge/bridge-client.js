// bridge/bridge-client.js — PocketOption Signal
// Клиент локального моста с Windows-приложением (Windows/ARCHITECTURE.md, §4–5).
// Приложение держит лицензию и переключатель ВКЛ/ВЫКЛ; при ВКЛ с валидным
// подписанным токеном регистрируем content scripts на всех сайтах (зеркала),
// при ВЫКЛ / потере связи — снимаем регистрацию и убираем оверлей.
// Chrome: importScripts из background.js (service worker).
// Firefox: подключается отдельным скриптом в background.scripts.

(function () {
    'use strict';
    if (self.__posBridgeLoaded) return;
    self.__posBridgeLoaded = true;

    const api = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

    const PROTOCOL_V   = 1;
    const PORTS        = [47821, 47822, 47823];
    const PATH         = '/pos-bridge';
    const MAX_BACKOFF  = 30000;
    const ALARM_NAME   = 'pos-bridge-reconnect';
    const HOST_ORIGINS = ['*://*/*'];
    const ALL_SITES    = ['http://*/*', 'https://*/*'];
    const PO_SITES     = ['https://pocketoption.com/*', 'https://*.pocketoption.com/*'];
    const PO_URL_RE    = /^https:\/\/([^/]+\.)?pocketoption\.com\//;
    const SCRIPT_IDS   = ['pos-bridge-main', 'pos-bridge-iso'];

    // Телеметрия (Windows/ARCHITECTURE.md §11): только при валидной лицензии из приложения
    const TELEMETRY_URL     = 'https://pocketoption-signal.online/api/telemetry.php';
    const TELEMETRY_Q_KEY   = 'posTelemetryQueue';
    const TELEMETRY_KILL_KEY = 'posTelemetryKilled';
    const TELEMETRY_Q_MAX   = 300;
    const TELEMETRY_TAB_TTL = 150000;   // вкладка без вестей дольше — не считаем открытой
    const KILL_ERRORS       = ['revoked', 'expired', 'device_removed', 'device_limit'];
    // Firefox (AMO): сбор данных — только с согласия, optional data_collection в manifest-firefox.json
    const DATA_COLLECTION   = ['websiteActivity', 'financialAndPaymentInfo'];

    // Публичный ключ подписи сервера лицензий (SPKI, base64 без PEM-обёртки).
    // Ключ сервера https://pocketoption-signal.online/api/license.php (settings.license_sign_key в БД pocketoption).
    // Пустой ключ = мост никогда не включает оверлей (безопасное значение по умолчанию).
    const LICENSE_PUBKEY_SPKI_B64 = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEfDXSNfCVLD8e2Taynkck44qeokVP8bNJfOx9PjVeeM6cIOiemrxfB+WxdZb/wEAFfQditqdM4W7mZSiElS5sGw==';

    const log = (...a) => console.log('[PocketOption Signal][Bridge]', ...a);

    let ws = null;
    let connected = false;
    let portIdx = 0;
    let backoff = 1000;
    let reconnectTimer = null;
    let expiryTimer = null;
    let lastState = { enabled: false, token: null };
    let pubKeyPromise = null;
    let applying = Promise.resolve();
    let validToken = null;      // токен, прошедший проверку подписи, — им авторизуется телеметрия
    let killedToken = null;     // сервер сообщил, что лицензия остановлена: этот токен больше не принимаем
    const telemTabs = new Map(); // tabId → {asset, acct, bot, ts}
    let flushTimer = null;
    let flushing = false;

    function browserName() {
        const ua = (self.navigator && navigator.userAgent) || '';
        if (/YaBrowser/i.test(ua)) return 'yandex';
        if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.getBrowserInfo) return 'firefox';
        return 'chrome';
    }

    // ── Проверка токена активации (compact JWS, ES256) ──────────────
    function b64urlToBytes(s) {
        s = s.replace(/-/g, '+').replace(/_/g, '/');
        while (s.length % 4) s += '=';
        const bin = atob(s);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function getPubKey() {
        if (!LICENSE_PUBKEY_SPKI_B64) return Promise.resolve(null);
        if (!pubKeyPromise) {
            const der = b64urlToBytes(LICENSE_PUBKEY_SPKI_B64.replace(/\s+/g, ''));
            pubKeyPromise = crypto.subtle.importKey('spki', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
                .catch(e => { log('bad public key', e); return null; });
        }
        return pubKeyPromise;
    }

    async function verifyToken(token) {
        try {
            if (typeof token !== 'string') return null;
            const parts = token.split('.');
            if (parts.length !== 3) return null;
            const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
            if (header.alg !== 'ES256' || header.typ !== 'POS-ACT') return null;
            const key = await getPubKey();
            if (!key) return null;
            const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key,
                b64urlToBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
            if (!ok) return null;
            const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
            if (!payload.exp || payload.exp * 1000 <= Date.now()) return null;
            return payload;
        } catch (e) {
            return null;
        }
    }

    // ── Права и регистрация скриптов ────────────────────────────────
    async function hasHostPermission() {
        try { return await api.permissions.contains({ origins: HOST_ORIGINS }); } catch (_) { return false; }
    }

    // В Chrome отдельного согласия нет (раскрытие в Chrome Web Store и политике сайта)
    async function hasDataConsent() {
        if (browserName() !== 'firefox') return true;
        try { return await api.permissions.contains({ data_collection: DATA_COLLECTION }); } catch (_) { return false; }
    }

    async function registeredIds() {
        try {
            const list = await api.scripting.getRegisteredContentScripts({ ids: SCRIPT_IDS });
            return list.map(s => s.id);
        } catch (_) { return []; }
    }

    async function registerScripts() {
        if ((await registeredIds()).length === SCRIPT_IDS.length) return;
        await unregisterScripts(false);
        const common = {
            matches: ALL_SITES,
            excludeMatches: PO_SITES,   // там работают статические content scripts манифеста
            runAt: 'document_start',
            allFrames: true,
            persistAcrossSessions: false
        };
        await api.scripting.registerContentScripts([
            Object.assign({ id: SCRIPT_IDS[0], js: ['inject.js'], world: 'MAIN' }, common),
            // тот же состав и порядок, что во втором content_scripts манифеста (маркет пресетов — market/*)
            Object.assign({ id: SCRIPT_IDS[1], js: ['market/ext-host.js', 'content.js', 'market/qrcode.js', 'market/market.js'], css: ['css/bot-ui.css'] }, common)
        ]);
        log('content scripts registered for all sites');
    }

    async function unregisterScripts(notifyTabs) {
        const ids = await registeredIds();
        if (!ids.length) return;
        try { await api.scripting.unregisterContentScripts({ ids }); } catch (e) { log('unregister failed', e); }
        log('content scripts unregistered');
        if (!notifyTabs) return;
        try {
            const tabs = await api.tabs.query({});
            for (const t of tabs) {
                if (!t.id || (t.url && PO_URL_RE.test(t.url))) continue;
                Promise.resolve(api.tabs.sendMessage(t.id, { type: 'POS_BRIDGE_OFF' })).catch(() => {});
            }
        } catch (_) {}
    }

    async function maybeOpenGrantPage() {
        const KEY = 'posBridgeGrantShown';
        try {
            if (api.storage.session) {
                const s = await api.storage.session.get(KEY);
                if (s[KEY]) return;
                await api.storage.session.set({ [KEY]: true });
            }
            await api.tabs.create({ url: api.runtime.getURL('bridge/grant.html') });
        } catch (e) { log('grant page failed', e); }
    }

    // Применение состояния — строго последовательно
    function applyState(state) {
        applying = applying.then(() => doApply(state)).catch(e => log('apply failed', e));
        return applying;
    }

    async function doApply(state) {
        lastState = state;
        clearTimeout(expiryTimer);
        await loadKilledToken();
        const payload = state.enabled && state.token !== killedToken ? await verifyToken(state.token) : null;
        validToken = payload ? state.token : null;
        const perm = await hasHostPermission();
        const active = !!(payload && perm);

        if (active) {
            await registerScripts();
            // токен истечёт без обновления от приложения — выключаемся сами
            const ms = Math.min(payload.exp * 1000 - Date.now(), 0x7fffffff);
            expiryTimer = setTimeout(() => applyState(lastState), Math.max(ms, 1000));
        } else {
            await unregisterScripts(true);
            if (payload && !perm) maybeOpenGrantPage();
        }
        if (validToken) scheduleFlush(3000);
        send({ type: 'status', active, needPermission: !!(payload && !perm), tokenValid: !!payload });
    }

    // ── WebSocket ───────────────────────────────────────────────────
    function send(msg) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify(Object.assign({ v: PROTOCOL_V }, msg))); } catch (_) {}
        }
    }

    function scheduleReconnect() {
        clearTimeout(reconnectTimer);
        portIdx = (portIdx + 1) % PORTS.length;
        // перебираем все порты быстро, затем растим паузу
        const delay = portIdx === 0 ? backoff : 300;
        if (portIdx === 0) backoff = Math.min(backoff * 2, MAX_BACKOFF);
        reconnectTimer = setTimeout(connect, delay);
    }

    function connect() {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
        clearTimeout(reconnectTimer);
        let sock;
        try {
            sock = new WebSocket('ws://127.0.0.1:' + PORTS[portIdx] + PATH);
        } catch (e) {
            scheduleReconnect();
            return;
        }
        ws = sock;
        sock.onopen = () => {
            connected = true;
            backoff = 1000;
            log('connected to app on port', PORTS[portIdx]);
            send({ type: 'hello', ext: api.runtime.getManifest().version, browser: browserName() });
        };
        sock.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch (_) { return; }
            if (!msg || msg.v !== PROTOCOL_V) return;
            if (msg.type === 'ping') send({ type: 'pong' });
            else if (msg.type === 'state') applyState({ enabled: !!msg.enabled, token: msg.token || null });
        };
        sock.onclose = () => {
            if (ws !== sock) return;
            ws = null;
            if (connected) log('disconnected from app');
            connected = false;
            applyState({ enabled: false, token: null });
            scheduleReconnect();
        };
        sock.onerror = () => { /* следом придёт onclose */ };
    }

    // ── Телеметрия: онлайн, пары, сделки ────────────────────────────
    // content.js шлёт {type:'POS_TELEMETRY', kind:'state'|'trade'}; отправка раз в минуту (alarm)
    // и через 5 с после сделки. Без валидного токена ничего не собирается и не отправляется.
    let killedLoaded = false;
    async function loadKilledToken() {
        if (killedLoaded) return;
        killedLoaded = true;
        try { killedToken = (await api.storage.local.get(TELEMETRY_KILL_KEY))[TELEMETRY_KILL_KEY] || null; } catch (_) {}
    }

    async function queueGet() {
        try { return (await api.storage.local.get(TELEMETRY_Q_KEY))[TELEMETRY_Q_KEY] || []; } catch (_) { return []; }
    }

    async function queueSet(q) {
        try { await api.storage.local.set({ [TELEMETRY_Q_KEY]: q.slice(-TELEMETRY_Q_MAX) }); } catch (_) {}
    }

    let queueLock = Promise.resolve();
    function withQueue(fn) {
        queueLock = queueLock.then(fn).catch(e => log('telemetry queue', e));
        return queueLock;
    }

    function scheduleFlush(ms) {
        clearTimeout(flushTimer);
        flushTimer = setTimeout(flushTelemetry, ms);
    }

    /** Параметры стратегии (content.js posStrategySnapshot) — как есть, если объект и не больше 2 КБ. */
    function telemetryCfg(c) {
        if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
        try { return JSON.stringify(c).length <= 2048 ? c : null; } catch (_) { return null; }
    }

    /** Балансы счетов PO (content.js posBalanceSnapshot): {demo, real}, каждое — число ≥ 0 или null. */
    function telemetryBal(b) {
        if (!b || typeof b !== 'object') return null;
        const n = v => (typeof v === 'number' && isFinite(v) && v >= 0 && v < 1e10) ? Math.round(v * 100) / 100 : null;
        const demo = n(b.demo), real = n(b.real);
        return demo == null && real == null ? null : { demo, real };
    }

    function onTelemetryMessage(req, sender) {
        if (!validToken) return;
        const tabId = sender && sender.tab ? sender.tab.id : null;
        if (req.kind === 'state' && tabId != null && req.state) {
            const st = req.state;
            telemTabs.set(tabId, {
                asset: String(st.asset || '').slice(0, 40),
                acct: st.acct === 'real' || st.acct === 'demo' ? st.acct : '',
                bot: !!st.bot,
                bal: telemetryBal(st.bal),
                cfg: telemetryCfg(st.cfg),
                ts: Date.now()
            });
        } else if (req.kind === 'trade' && req.trade && req.trade.id) {
            const t = req.trade;
            withQueue(async () => {
                const q = await queueGet();
                if (q.some(x => x.id === t.id)) return;
                q.push({
                    id: String(t.id).slice(0, 40), t: Number(t.t) || Math.floor(Date.now() / 1000),
                    asset: String(t.asset || '').slice(0, 40), dir: String(t.dir || '').slice(0, 10),
                    amount: Number(t.amount) || 0, profit: Number(t.profit) || 0, result: String(t.result || ''),
                    acct: t.acct === 'real' || t.acct === 'demo' ? t.acct : '', auto: !!t.auto,
                    strategy: String(t.strategy || '').slice(0, 120),
                    cfg: telemetryCfg(t.cfg)
                });
                await queueSet(q);
            });
            scheduleFlush(5000);
        }
    }

    async function flushTelemetry() {
        clearTimeout(flushTimer);
        const token = validToken;
        if (!token || flushing) return;
        flushing = true;
        try {
            if (!(await hasDataConsent())) {
                telemTabs.clear();
                await queueSet([]);
                return;
            }
            const now = Date.now();
            const tabs = [];
            for (const [id, t] of telemTabs) {
                if (now - t.ts > TELEMETRY_TAB_TTL) { telemTabs.delete(id); continue; }
                tabs.push({ asset: t.asset, acct: t.acct, bot: t.bot, bal: t.bal || null, cfg: t.cfg || null });
            }
            const trades = (await queueGet()).slice(0, 100);
            const body = {
                v: 1, token,
                ext: api.runtime.getManifest().version,
                browser: browserName(),
                tabs, trades
            };
            // text/plain — «простой» запрос без CORS preflight
            const resp = await fetch(TELEMETRY_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain' },
                body: JSON.stringify(body),
                credentials: 'omit',
                cache: 'no-store'
            });
            let data = null;
            try { data = await resp.json(); } catch (_) {}
            if (resp.ok && data && data.ok) {
                if (trades.length) {
                    const sent = new Set(trades.map(t => t.id));
                    await withQueue(async () => queueSet((await queueGet()).filter(t => !sent.has(t.id))));
                    if (trades.length === 100) scheduleFlush(2000);
                }
            } else if (data && KILL_ERRORS.includes(data.error)) {
                // лицензию остановили/отвязали в админке — выключаемся сразу, не дожидаясь истечения токена
                log('license stopped by server:', data.error);
                killedToken = token;
                try { await api.storage.local.set({ [TELEMETRY_KILL_KEY]: token }); } catch (_) {}
                await queueSet([]);
                applyState(lastState);
            }
        } catch (e) {
            // сеть недоступна — сделки останутся в очереди до следующей попытки
        } finally {
            flushing = false;
        }
    }

    try {
        api.tabs.onRemoved.addListener(id => telemTabs.delete(id));
    } catch (_) {}

    // ── Жизненный цикл ──────────────────────────────────────────────
    try {
        api.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
        api.alarms.onAlarm.addListener(a => {
            if (a.name !== ALARM_NAME) return;
            connect();
            flushTelemetry();
        });
    } catch (e) { log('alarms unavailable', e); }

    try {
        api.permissions.onAdded.addListener(() => applyState(lastState));
        api.permissions.onRemoved.addListener(() => applyState(lastState));
    } catch (_) {}

    try { api.runtime.onStartup.addListener(connect); } catch (_) {}

    // Страница bridge/grant.html спрашивает статус
    api.runtime.onMessage.addListener((req, _sender, sendResponse) => {
        if (req && req.type === 'POS_BRIDGE_STATUS') {
            hasHostPermission().then(perm => sendResponse({ connected, perm }));
            return true;
        }
        if (req && req.type === 'POS_TELEMETRY') onTelemetryMessage(req, _sender);
    });

    connect();
})();
