// market/ext-host.js — хост экрана «Маркет» (market/market.js) в браузерном расширении (≥ 3.6.0).
// Content script изолированного мира, грузится до content.js: объявляет __posChrome.posApp — тот же интерфейс, что
// host-shim.js в Windows-приложении (market, openUrl, core, drawer, ui), плюс account — вход в аккаунт маркета.
// Сеть и токен — в background.js (POS_MARKET*): fetch к /api/market.php из service worker (host_permissions, без CORS),
// токен маркета лежит в chrome.storage.local и в эту страницу не передаётся. Протокол — Windows/ARCHITECTURE.md §18.
// В iframe маркета нет: __posChrome = null.
var __posChrome = (function () {
    'use strict';
    if (window !== window.top) return null;
    var SITE_RE = /^https:\/\/pocketoption-signal\.online\//;

    function send(msg, timeoutMs) {
        return new Promise(function (resolve) {
            var done = false;
            var finish = function (r) { if (!done) { done = true; resolve(r); } };
            setTimeout(function () { finish(undefined); }, timeoutMs || 30000);
            try {
                chrome.runtime.sendMessage(msg, function (r) {
                    void chrome.runtime.lastError; // SW перезапускается / расширение обновлено — ответ undefined
                    finish(r);
                });
            } catch (_) { finish(undefined); }
        });
    }
    function obj(r, fallback) { return (r && typeof r === 'object') ? r : fallback; }

    var posApp = {
        host: 'extension',
        /** Запрос к API маркета → ответ сервера как есть (+status); сеть — {ok:false, error:'network'}. */
        market: function (action, params) {
            return send({ type: 'POS_MARKET', action: String(action || ''), params: params || {} })
                .then(function (r) { return obj(r, { ok: false, error: 'network' }); });
        },
        /** Ссылки сайта проекта (оплата, профиль) — в новой вкладке. */
        openUrl: function (url) {
            url = String(url || '');
            if (!SITE_RE.test(url)) return;
            try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (_) {}
        },
        account: {
            /** {email} — вошли, {email:null} — нет. */
            state: function () {
                return send({ type: 'POS_MARKET_AUTH' }, 5000).then(function (r) { return obj(r, { email: null }); });
            },
            /** Вход email + паролем (+ код 2FA). Ответ: {ok, account:{email,nickname}} или {ok:false, error}. */
            login: function (email, password, totp, lang) {
                return send({ type: 'POS_MARKET_LOGIN', email: email, password: password, totp: totp || '', lang: lang })
                    .then(function (r) { return obj(r, { ok: false, error: 'network' }); });
            },
            logout: function () { return send({ type: 'POS_MARKET_LOGOUT' }, 5000).then(function () { return { ok: true }; }); }
        },
        core: null,   // content.js (снимок/применение настроек, библиотека «Пресетов стратегии»)
        drawer: null, // в расширении панель плавающая, выезжающей нет
        ui: null      // market.js
    };
    return { posApp: posApp };
})();
