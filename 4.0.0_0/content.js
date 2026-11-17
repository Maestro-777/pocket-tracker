// content.js - PocketOption Signal v3.6.0
// Platform: Pocket Option (pocketoption.com)
// Site: pocketoption-signal.online

(function () {
    'use strict';

    const BRAND_NAME = 'PocketOption Signal';
    const BRAND_SITE = 'pocketoption-signal.online';
    const BRAND_VERSION = '3.6.0';

    const IS_TOP = (window === window.top);

    // ── ACCESS MODE (free) ───────────────────────────────────────────
    const API_BASE  = 'https://pocketoption-signal.online/api';
    const _RS       = 'Xk9$Bn2R@mV7pLq!tZ'; // request-signing secret
    const detectUID = detectPocketOptionUID;

    async function _sign(body) {
        var extId = (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime.id : 'dev';
        var ts    = Date.now();
        var enc   = new TextEncoder();
        var ck    = await crypto.subtle.importKey('raw', enc.encode(_RS),
            { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        var plain = extId + ':' + ts + ':' + JSON.stringify(body);
        var sig   = await crypto.subtle.sign('HMAC', ck, enc.encode(plain));
        var hex   = Array.from(new Uint8Array(sig))
            .map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
        return Object.assign({}, body, { _eid: extId, _ts: ts, _sig: hex });
    }

    function detectPocketOptionUID() {
        var attempts = [
            function() { return window._poRobotUID; },
            function() { return window.user && window.user.id; },
            function() { return window.CURRENT_USER && window.CURRENT_USER.id; },
            function() { return window._po_user && window._po_user.id; },
            function() {
                var el = document.querySelector('.user-id, [class*="userId"], [class*="user-id"], .account-id, [data-user-id]');
                return el && parseInt((el.textContent || el.getAttribute('data-user-id') || '').replace(/\D/g,''));
            },
            function() {
                var m = document.cookie.match(/user[_-]?id=([0-9]+)/i);
                return m && parseInt(m[1]);
            },
            function() {
                var m = (document.body && document.body.innerHTML || '').match(/"id":([0-9]+),"email"/);
                return m && parseInt(m[1]);
            }
        ];
        for (var i = 0; i < attempts.length; i++) {
            try { var v = attempts[i](); if (v && parseInt(v) > 0) return parseInt(v); } catch(e) {}
        }
        return null;
    }

    function isTokenFresh(token) {
        try {
            var payload = atob(token.split('.')[0]);
            var expiry  = parseInt(payload.split(':')[1]);
            return Date.now() < expiry;
        } catch(e) { return false; }
    }

    async function serverCheck(uid, token) {
        try {
            var body = {};
            if (token) body.token = token;
            if (uid)   body.uid   = uid;
            var signed = await _sign(body);
            var url = API_BASE + '/check.php';
            console.log('[PocketOption Signal] serverCheck → POST', url, 'uid=', uid);
            var resp = await fetch(url, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(signed),
            });
            console.log('[PocketOption Signal] serverCheck ← status', resp.status);
            if (!resp.ok) {
                console.warn('[PocketOption Signal] serverCheck HTTP error', resp.status, await resp.text().catch(()=>''));
                return null; // HTTP error - treat as not authorized
            }
            var data = await resp.json();
            console.log('[PocketOption Signal] serverCheck response:', data);
            return data.valid ? data.token : null;
        } catch(e) {
            console.error('[PocketOption Signal] serverCheck network error:', e.message);
            return undefined; // true network error (offline, DNS fail) - caller decides
        }
    }

    async function checkActivation() {
        return true;
    }


    const STRATEGIES = [
        { id: 'RSI',       name: 'RSI',          desc: 'Перекуп./Перепрод.',  en_desc: 'Overbought/Oversold',   icon: '📊' },
        { id: 'EMA',       name: 'EMA Cross',     desc: 'Быстрая/медл. EMA',   en_desc: 'Fast/Slow EMA cross',   icon: '📈' },
        { id: 'SMA',       name: 'SMA Cross',     desc: 'Пересечение средних', en_desc: 'MA crossover',           icon: '〰' },
        { id: 'BB',        name: 'Bollinger',     desc: 'Возврат к среднему',  en_desc: 'Return to mean',         icon: '🔔' },
        { id: 'MACD',      name: 'MACD',          desc: 'MACD / Signal',       en_desc: 'MACD / Signal line',     icon: '🌊' },
        { id: 'STOCH',     name: 'Stochastic',    desc: 'K%/D% зоны',         en_desc: 'K%/D% zones',            icon: '⚡' },
        { id: 'CCI',       name: 'CCI',           desc: 'Канал ±100',          en_desc: 'Channel ±100',           icon: '🎯' },
        { id: 'TREND',     name: 'Trend',         desc: 'Следование тренду',   en_desc: 'Trend following',        icon: '🚀' },
        { id: 'PSAR',      name: 'Parabolic SAR', desc: 'Разворот тренда',     en_desc: 'Trend reversal',         icon: '🔄' },
        { id: 'SENTIMENT', name: 'Sentiment',     desc: 'Настроение рынка',    en_desc: 'Market sentiment',       icon: '🧠' },
    ];

    const MM_OPTIONS = [
        { id: 'fixed',      name: 'Фиксированная ставка', en_name: 'Fixed Bet',       extra: null    },
        { id: 'martingale', name: 'Мартингейл',            en_name: 'Martingale',      extra: 'mult'  },
        { id: 'anti_mart',  name: 'Анти-Мартингейл',      en_name: 'Anti-Martingale', extra: 'mult'  },
        { id: 'fibonacci',  name: 'Фибоначчи',             en_name: 'Fibonacci',       extra: null    },
        { id: 'dalembert',  name: "Д'Аламбер",             en_name: "D'Alembert",      extra: 'unit'  },
        { id: 'oscar',      name: "Oscar's Grind",         en_name: "Oscar's Grind",   extra: 'unit'  },
        { id: 'parlay',     name: 'Парлай',                 en_name: 'Parlay',          extra: 'steps' },
        { id: 'labouchere', name: 'Лабушер',                en_name: 'Labouchère',      extra: 'lab'   },
        { id: 'boost',      name: 'Разгон депозита',           en_name: 'Deposit Boost',   extra: 'boost' },
    ];

    // Built-in presets grouped by expiration tabs
    const PRESET_EXP_TABS = [
        { exp: 3,   label: '3с',   en_label: '3s',   hint: 'Ультра-скальп: только самые строгие совпадения. Сделок мало - шум на 3с очень высокий.', en_hint: 'Ultra-scalp: only the strictest matches. Few trades - 3s noise is very high.' },
        { exp: 15,  label: '15с',  en_label: '15s',  hint: 'Скальп: быстрые свечи, короткие периоды. Лучше на подвижных OTC.', en_hint: 'Scalp: fast candles, short periods. Best on moving OTC.' },
        { exp: 30,  label: '30с',  en_label: '30s',  hint: 'Баланс скорость/шум. Отскоки и всплески волатильности.', en_hint: 'Speed/noise balance. Bounces and volatility spikes.' },
        { exp: 60,  label: '1м',   en_label: '1m',   hint: 'Минутный импульс и подтверждение толпы. Стабильнее скальпа.', en_hint: '1m momentum and crowd confirm. More stable than scalp.' },
        { exp: 180, label: '3м',   en_label: '3m',   hint: 'Чистый тренд, меньше сделок, выше качество входа.', en_hint: 'Cleaner trend, fewer trades, higher entry quality.' },
        { exp: 300, label: '5м',   en_label: '5m',   hint: 'Спокойные сессионные входы. Классические периоды индикаторов.', en_hint: 'Calm session entries. Classic indicator periods.' }
    ];

    // Каждый пресет собран под один стиль входа. Смешивать трендовые фильтры
    // с возвратными в режиме ВСЕ нельзя: они требуют противоположных условий
    // и в паре не срабатывают почти никогда.
    //   ALL      - все фильтры одного стиля должны совпасть
    //   ANY      - каждый фильтр торгует сам, подтверждение под его стиль
    //   CONTEXT  - тренд задаёт направление, осциллятор даёт момент входа
    // confirmMode: trend (продолжение) | reversion (истощение) | auto | off
    const BUILTIN_PRESETS = [
        // ── 3s (максимально строгий отбор; 100% на 3с невозможно) ──
        {
            id: 's3_precision', tag: 'Max', tone: 'safe',
            name: 'Precision Lock', en_name: 'Precision Lock',
            desc: 'Микротренд EMA/TREND задаёт сторону, RSI и Stochastic ловят откат. Плюс HTF. Самый строгий отбор на 3с - сделок мало, без обещания 100%.',
            en_desc: 'EMA/TREND micro-trend sets the side, RSI and Stochastic catch the pullback. Plus HTF. Strictest 3s selection - few trades, no 100% promise.',
            selectedStrategies: ['EMA', 'TREND', 'RSI', 'STOCH'], filterMode: 'CONTEXT', expiration: 3,
            confirmMode: 'reversion',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 4, riskTlMode: 'percent', riskTlValue: 3,
            htfFilter: true, suggestedBet: 1,
            indConfig: {
                EMA: { fast: 2, slow: 7 },
                TREND: { period: 2 },
                RSI: { period: 5, oversold: 25, overbought: 75 },
                STOCH: { kPeriod: 5, dPeriod: 2, oversold: 20, overbought: 80 }
            }
        },
        {
            id: 's3_triple', tag: 'Lock', tone: 'trend',
            name: 'Triple Lock', en_name: 'Triple Lock',
            desc: 'Чистое следование импульсу: TREND + EMA + MACD в одну сторону, плюс HTF. Разные семейства, а не три вида одной средней.',
            en_desc: 'Pure momentum following: TREND + EMA + MACD aligned, plus HTF. Different families, not three flavours of one average.',
            selectedStrategies: ['TREND', 'EMA', 'MACD'], filterMode: 'ALL', expiration: 3,
            confirmMode: 'trend',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 4, riskTlMode: 'percent', riskTlValue: 3,
            htfFilter: true, suggestedBet: 1,
            indConfig: {
                TREND: { period: 2 },
                EMA: { fast: 2, slow: 7 },
                MACD: { fast: 5, slow: 11, signal: 4 }
            }
        },
        {
            id: 's3_pullback', tag: 'Snap', tone: 'bounce',
            name: 'Micro Pullback', en_name: 'Micro Pullback',
            desc: 'Облегчённый откат: EMA держит сторону, Stochastic даёт вход. Без HTF - входов заметно больше.',
            en_desc: 'Light pullback: EMA holds the side, Stochastic triggers entry. No HTF - noticeably more entries.',
            selectedStrategies: ['EMA', 'STOCH'], filterMode: 'CONTEXT', expiration: 3,
            confirmMode: 'reversion',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 3, riskTlMode: 'percent', riskTlValue: 2,
            htfFilter: false, suggestedBet: 1,
            indConfig: {
                EMA: { fast: 2, slow: 7 },
                STOCH: { kPeriod: 5, dPeriod: 2, oversold: 25, overbought: 75 }
            }
        },
        {
            id: 's3_iron', tag: 'Iron', tone: 'safe',
            name: 'Iron Filter', en_name: 'Iron Filter',
            desc: 'Четыре трендовых фильтра разных семейств + HTF. Редкие входы, максимальный контроль.',
            en_desc: 'Four trend filters from different families + HTF. Rare entries, maximum control.',
            selectedStrategies: ['EMA', 'MACD', 'TREND', 'PSAR'], filterMode: 'ALL', expiration: 3,
            confirmMode: 'trend',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 3, riskTlMode: 'percent', riskTlValue: 2,
            htfFilter: true, suggestedBet: 1,
            indConfig: {
                EMA: { fast: 2, slow: 8 },
                MACD: { fast: 5, slow: 11, signal: 4 },
                TREND: { period: 3 },
                PSAR: { fastEma: 2, slowEma: 6 }
            }
        },
        // ── 15s ──
        {
            id: 's15_pulse', tag: 'Pulse', tone: 'scalp',
            name: 'Scalp Pulse', en_name: 'Scalp Pulse',
            desc: 'Основной скальп 15с: TREND + EMA + MACD, подтверждение по продолжению движения.',
            en_desc: 'Core 15s scalp: TREND + EMA + MACD with continuation confirmation.',
            selectedStrategies: ['TREND', 'EMA', 'MACD'], filterMode: 'ALL', expiration: 15,
            confirmMode: 'trend',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 6, riskTlMode: 'percent', riskTlValue: 5,
            indConfig: { TREND: { period: 3 }, EMA: { fast: 3, slow: 10 }, MACD: { fast: 8, slow: 17, signal: 6 } }
        },
        {
            id: 's15_pullback', tag: 'Pull', tone: 'scalp',
            name: 'Trend Pullback', en_name: 'Trend Pullback',
            desc: 'Откат по тренду: EMA и TREND задают сторону, RSI ловит просадку внутри движения. Лучший компромисс между частотой и качеством.',
            en_desc: 'Pullback with the trend: EMA and TREND set the side, RSI catches the dip inside the move. Best frequency/quality trade-off.',
            selectedStrategies: ['EMA', 'TREND', 'RSI'], filterMode: 'CONTEXT', expiration: 15,
            confirmMode: 'reversion',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 6, riskTlMode: 'percent', riskTlValue: 4,
            htfFilter: true,
            indConfig: { EMA: { fast: 3, slow: 10 }, TREND: { period: 3 }, RSI: { period: 7, oversold: 32, overbought: 68 } }
        },
        {
            id: 's15_micro_bounce', tag: 'Bounce', tone: 'bounce',
            name: 'Micro Bounce', en_name: 'Micro Bounce',
            desc: 'Возврат к среднему: RSI + Stochastic + Bollinger. Вход на истощении движения, HTF намеренно выключен.',
            en_desc: 'Mean-reversion: RSI + Stochastic + Bollinger. Entry on exhaustion, HTF intentionally off.',
            selectedStrategies: ['RSI', 'STOCH', 'BB'], filterMode: 'ALL', expiration: 15,
            confirmMode: 'reversion',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 5, riskTlMode: 'percent', riskTlValue: 4,
            htfFilter: false,
            indConfig: { RSI: { period: 7, oversold: 25, overbought: 75 }, STOCH: { kPeriod: 7, dPeriod: 3, oversold: 20, overbought: 80 }, BB: { period: 10, dev: 2 } }
        },
        {
            id: 's15_impulse', tag: 'Impulse', tone: 'momentum',
            name: 'Impulse Snap', en_name: 'Impulse Snap',
            desc: 'Быстрый импульс: EMA + TREND + PSAR. Ловит резкие микро-движения.',
            en_desc: 'Fast impulse: EMA + TREND + PSAR. Catches sharp micro-moves.',
            selectedStrategies: ['EMA', 'TREND', 'PSAR'], filterMode: 'ALL', expiration: 15,
            confirmMode: 'trend',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 6, riskTlMode: 'percent', riskTlValue: 5,
            indConfig: { EMA: { fast: 3, slow: 10 }, TREND: { period: 3 }, PSAR: { fastEma: 3, slowEma: 8 } }
        },
        {
            id: 's15_multi', tag: 'ANY', tone: 'any',
            name: 'Multi Fire', en_name: 'Multi Fire',
            desc: 'ЛЮБОЙ: каждый фильтр = сделка, подтверждение подбирается под его стиль. Чаще входы, жёсткий TL, малая ставка.',
            en_desc: 'ANY: each filter trades alone with confirmation matched to its style. More entries, tight TL, small size.',
            selectedStrategies: ['RSI', 'EMA', 'TREND'], filterMode: 'ANY', expiration: 15,
            confirmMode: 'auto',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 5, riskTlMode: 'percent', riskTlValue: 4,
            indConfig: { RSI: { period: 7, oversold: 25, overbought: 75 }, EMA: { fast: 3, slow: 10 }, TREND: { period: 3 } }
        },
        // ── 30s ──
        {
            id: 's30_bounce', tag: 'Bounce', tone: 'bounce',
            name: 'Bounce Zone', en_name: 'Bounce Zone',
            desc: 'Классический отскок: RSI + Stochastic + Bollinger, подтверждение по истощению. Лучший баланс на 30с.',
            en_desc: 'Classic bounce: RSI + Stochastic + Bollinger with exhaustion confirmation. Best 30s balance.',
            selectedStrategies: ['RSI', 'STOCH', 'BB'], filterMode: 'ALL', expiration: 30,
            confirmMode: 'reversion',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 8, riskTlMode: 'percent', riskTlValue: 6,
            htfFilter: false,
            indConfig: { RSI: { period: 9, oversold: 28, overbought: 72 }, STOCH: { kPeriod: 9, dPeriod: 3, oversold: 20, overbought: 80 }, BB: { period: 12, dev: 2 } }
        },
        {
            id: 's30_vol', tag: 'Vol', tone: 'vol',
            name: 'Volatility Snap', en_name: 'Volatility Snap',
            desc: 'Экстремумы волатильности: BB + CCI. Узкая пара фильтров разных семейств для импульсных OTC.',
            en_desc: 'Volatility extremes: BB + CCI. A tight pair from different families for impulsive OTC.',
            selectedStrategies: ['BB', 'CCI'], filterMode: 'ALL', expiration: 30,
            confirmMode: 'reversion',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 7, riskTlMode: 'percent', riskTlValue: 5,
            htfFilter: false,
            indConfig: { BB: { period: 12, dev: 2.5 }, CCI: { period: 12, level: 120 } }
        },
        {
            id: 's30_trend', tag: 'Trend', tone: 'trend',
            name: 'Quick Trend', en_name: 'Quick Trend',
            desc: 'Короткий тренд: EMA + TREND + MACD, вход по продолжению.',
            en_desc: 'Short trend: EMA + TREND + MACD, continuation entry.',
            selectedStrategies: ['EMA', 'TREND', 'MACD'], filterMode: 'ALL', expiration: 30,
            confirmMode: 'trend',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 7, riskTlMode: 'percent', riskTlValue: 5,
            indConfig: { EMA: { fast: 4, slow: 14 }, TREND: { period: 4 }, MACD: { fast: 10, slow: 21, signal: 7 } }
        },
        {
            id: 's30_pullback', tag: 'Pull', tone: 'trend',
            name: 'Zone Pullback', en_name: 'Zone Pullback',
            desc: 'Тренд EMA/TREND + двойной триггер RSI и Stochastic на откате. HTF подтверждает старший таймфрейм.',
            en_desc: 'EMA/TREND trend + dual RSI and Stochastic trigger on the pullback. HTF confirms the higher timeframe.',
            selectedStrategies: ['EMA', 'TREND', 'RSI', 'STOCH'], filterMode: 'CONTEXT', expiration: 30,
            confirmMode: 'reversion',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 8, riskTlMode: 'percent', riskTlValue: 5,
            htfFilter: true, suggestedBet: 2,
            indConfig: { EMA: { fast: 4, slow: 14 }, TREND: { period: 4 }, RSI: { period: 9, oversold: 32, overbought: 68 }, STOCH: { kPeriod: 11, dPeriod: 3, oversold: 25, overbought: 75 } }
        },
        {
            id: 's30_dual', tag: 'ANY', tone: 'any',
            name: 'Dual Confirm', en_name: 'Dual Confirm',
            desc: 'ЛЮБОЙ из RSI/EMA. Два независимых входа со своим подтверждением у каждого.',
            en_desc: 'ANY of RSI/EMA. Two independent entries, each with its own confirmation.',
            selectedStrategies: ['RSI', 'EMA'], filterMode: 'ANY', expiration: 30,
            confirmMode: 'auto',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 6, riskTlMode: 'percent', riskTlValue: 4,
            indConfig: { RSI: { period: 9, oversold: 28, overbought: 72 }, EMA: { fast: 4, slow: 14 } }
        },
        // ── 60s ──
        {
            id: 's60_momentum', tag: 'Flow', tone: 'momentum',
            name: 'Momentum Flow', en_name: 'Momentum Flow',
            desc: 'Импульс на минутной свече: EMA + MACD + TREND.',
            en_desc: '1m momentum: EMA + MACD + TREND.',
            selectedStrategies: ['EMA', 'MACD', 'TREND'], filterMode: 'ALL', expiration: 60,
            confirmMode: 'trend',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 10, riskTlMode: 'percent', riskTlValue: 7,
            indConfig: { EMA: { fast: 5, slow: 18 }, MACD: { fast: 12, slow: 26, signal: 9 }, TREND: { period: 5 } }
        },
        {
            id: 's60_crowd', tag: 'Crowd', tone: 'sent',
            name: 'Crowd Confirm', en_name: 'Crowd Confirm',
            desc: 'Настроение толпы и EMA задают сторону, RSI выбирает момент. Сильно на активных OTC.',
            en_desc: 'Crowd sentiment and EMA set the side, RSI picks the moment. Strong on active OTC.',
            selectedStrategies: ['SENTIMENT', 'EMA', 'RSI'], filterMode: 'CONTEXT', expiration: 60,
            confirmMode: 'reversion',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 8, riskTlMode: 'percent', riskTlValue: 6,
            indConfig: { SENTIMENT: { threshold: 60 }, EMA: { fast: 5, slow: 18 }, RSI: { period: 10, oversold: 32, overbought: 68 } }
        },
        {
            id: 's60_revert', tag: 'Revert', tone: 'bounce',
            name: 'Minute Revert', en_name: 'Minute Revert',
            desc: 'Минутный возврат к среднему: RSI + BB + Stochastic, вход на затухании импульса.',
            en_desc: '1m mean-reversion: RSI + BB + Stochastic, entry as momentum fades.',
            selectedStrategies: ['RSI', 'BB', 'STOCH'], filterMode: 'ALL', expiration: 60,
            confirmMode: 'reversion',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 9, riskTlMode: 'percent', riskTlValue: 6,
            htfFilter: false,
            indConfig: { RSI: { period: 10, oversold: 30, overbought: 70 }, BB: { period: 14, dev: 2 }, STOCH: { kPeriod: 10, dPeriod: 3, oversold: 20, overbought: 80 } }
        },
        {
            id: 's60_psar', tag: 'Flip', tone: 'vol',
            name: 'PSAR Flip', en_name: 'PSAR Flip',
            desc: 'После смены микро-тренда: PSAR и EMA держат новую сторону, RSI даёт вход на откате.',
            en_desc: 'After a micro-trend flip: PSAR and EMA hold the new side, RSI triggers on the pullback.',
            selectedStrategies: ['PSAR', 'EMA', 'RSI'], filterMode: 'CONTEXT', expiration: 60,
            confirmMode: 'reversion',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 8, riskTlMode: 'percent', riskTlValue: 6,
            indConfig: { PSAR: { fastEma: 3, slowEma: 10 }, EMA: { fast: 5, slow: 18 }, RSI: { period: 10, oversold: 32, overbought: 68 } }
        },
        {
            id: 's60_maxconf', tag: 'Max', tone: 'safe',
            name: 'Max Confluence', en_name: 'Max Confluence',
            desc: 'Три трендовых фильтра держат сторону, RSI и Stochastic ищут откат, сверху HTF. Сделок мало, но каждая проходит максимум проверок. Не гарантия выигрыша - только жёсткий отбор.',
            en_desc: 'Three trend filters hold the side, RSI and Stochastic look for the pullback, HTF on top. Few trades, but each passes maximum checks. Not a win guarantee - just strict selection.',
            selectedStrategies: ['EMA', 'MACD', 'TREND', 'RSI', 'STOCH'], filterMode: 'CONTEXT', expiration: 60,
            confirmMode: 'reversion',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 8, riskTlMode: 'percent', riskTlValue: 5,
            htfFilter: true, suggestedBet: 3,
            indConfig: { EMA: { fast: 5, slow: 18 }, MACD: { fast: 12, slow: 26, signal: 9 }, TREND: { period: 5 }, RSI: { period: 10, oversold: 35, overbought: 65 }, STOCH: { kPeriod: 14, dPeriod: 3, oversold: 25, overbought: 75 } }
        },
        // ── 180s (M3; M2 у PocketOption нет) ──
        {
            id: 's180_guard', tag: 'Guard', tone: 'trend',
            name: 'Trend Guard', en_name: 'Trend Guard',
            desc: 'Чистый тренд: EMA + MACD + TREND. Меньше сделок, выше качество.',
            en_desc: 'Clean trend: EMA + MACD + TREND. Fewer, higher-quality entries.',
            selectedStrategies: ['EMA', 'MACD', 'TREND'], filterMode: 'ALL', expiration: 180,
            confirmMode: 'trend',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 12, riskTlMode: 'percent', riskTlValue: 8,
            indConfig: { EMA: { fast: 5, slow: 20 }, MACD: { fast: 12, slow: 26, signal: 9 }, TREND: { period: 5 } }
        },
        {
            id: 's180_swing', tag: 'Swing', tone: 'bounce',
            name: 'Swing Bounce', en_name: 'Swing Bounce',
            desc: 'Отскок на 3м: RSI + BB + CCI. Зоны перекупленности и перепроданности, вход на истощении.',
            en_desc: '3m bounce: RSI + BB + CCI. Overbought/oversold zones, entry on exhaustion.',
            selectedStrategies: ['RSI', 'BB', 'CCI'], filterMode: 'ALL', expiration: 180,
            confirmMode: 'reversion',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 10, riskTlMode: 'percent', riskTlValue: 7,
            htfFilter: false,
            indConfig: { RSI: { period: 12, oversold: 30, overbought: 70 }, BB: { period: 16, dev: 2 }, CCI: { period: 16, level: 100 } }
        },
        {
            id: 's180_steady', tag: 'Steady', tone: 'momentum',
            name: 'Steady Flow', en_name: 'Steady Flow',
            desc: 'EMA и MACD держат направление, RSI даёт вход на откате. Спокойный поток сделок.',
            en_desc: 'EMA and MACD hold direction, RSI triggers on the pullback. A calm trade flow.',
            selectedStrategies: ['EMA', 'MACD', 'RSI'], filterMode: 'CONTEXT', expiration: 180,
            confirmMode: 'reversion',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 11, riskTlMode: 'percent', riskTlValue: 7,
            indConfig: { EMA: { fast: 5, slow: 20 }, MACD: { fast: 12, slow: 26, signal: 9 }, RSI: { period: 12, oversold: 33, overbought: 67 } }
        },
        // ── 300s ──
        {
            id: 's300_safe', tag: 'Safe', tone: 'safe',
            name: 'Conservative', en_name: 'Conservative',
            desc: 'Классика 5м: EMA и MACD задают тренд, RSI или Bollinger ловят откат. Редкие спокойные входы.',
            en_desc: 'Classic 5m: EMA and MACD set the trend, RSI or Bollinger catch the pullback. Rare calm entries.',
            selectedStrategies: ['EMA', 'MACD', 'RSI', 'BB'], filterMode: 'CONTEXT', expiration: 300,
            confirmMode: 'reversion',
            triggerPolicy: 'any',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 15, riskTlMode: 'percent', riskTlValue: 10,
            indConfig: { EMA: { fast: 8, slow: 21 }, MACD: { fast: 12, slow: 26, signal: 9 }, RSI: { period: 14, oversold: 35, overbought: 65 }, BB: { period: 20, dev: 2 } }
        },
        {
            id: 's300_trend', tag: 'Trend', tone: 'trend',
            name: 'Session Trend', en_name: 'Session Trend',
            desc: 'Сессионный тренд: EMA + MACD + TREND с классическими периодами.',
            en_desc: 'Session trend: EMA + MACD + TREND with classic periods.',
            selectedStrategies: ['EMA', 'MACD', 'TREND'], filterMode: 'ALL', expiration: 300,
            confirmMode: 'trend',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 14, riskTlMode: 'percent', riskTlValue: 9,
            indConfig: { EMA: { fast: 8, slow: 21 }, MACD: { fast: 12, slow: 26, signal: 9 }, TREND: { period: 7 } }
        },
        {
            id: 's300_mean', tag: 'Mean', tone: 'bounce',
            name: 'Session Mean', en_name: 'Session Mean',
            desc: 'Сессионный возврат к среднему: RSI + Stochastic + BB. Зоны на 5м без трендового фильтра.',
            en_desc: 'Session mean-reversion: RSI + Stochastic + BB. 5m zones without a trend filter.',
            selectedStrategies: ['RSI', 'STOCH', 'BB'], filterMode: 'ALL', expiration: 300,
            confirmMode: 'reversion',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 12, riskTlMode: 'percent', riskTlValue: 8,
            htfFilter: false,
            indConfig: { RSI: { period: 14, oversold: 30, overbought: 70 }, STOCH: { kPeriod: 14, dPeriod: 3, oversold: 20, overbought: 80 }, BB: { period: 20, dev: 2 } }
        },
        {
            id: 's300_maxconf', tag: 'Max', tone: 'safe',
            name: 'Max Confluence', en_name: 'Max Confluence',
            desc: 'Тренд EMA/MACD/TREND, вход по RSI или Bollinger, сверху HTF на старшем таймфрейме. Максимальная избирательность, минимум сделок. Не гарантия выигрыша - только жёсткий отбор.',
            en_desc: 'EMA/MACD/TREND trend, entry via RSI or Bollinger, HTF on top. Maximum selectivity, minimal trade count. Not a win guarantee - just strict selection.',
            selectedStrategies: ['EMA', 'MACD', 'TREND', 'RSI', 'BB'], filterMode: 'CONTEXT', expiration: 300,
            confirmMode: 'reversion',
            moneyManagement: 'fixed', riskTpMode: 'percent', riskTpValue: 12, riskTlMode: 'percent', riskTlValue: 8,
            htfFilter: true, suggestedBet: 4,
            indConfig: { EMA: { fast: 8, slow: 21 }, MACD: { fast: 12, slow: 26, signal: 9 }, TREND: { period: 7 }, RSI: { period: 14, oversold: 33, overbought: 67 }, BB: { period: 20, dev: 2.2 } }
        }
    ];

    let activeBuiltinPresetId = null;
    let activePresetExpTab = 15;

    const IND_PARAMS_META = {
        RSI:     [
            { key: 'period',     label: 'Период',    en_label: 'Period',      min: 2,  max: 50,  step: 1,   def: 14 },
            { key: 'oversold',   label: 'Перепрод.', en_label: 'Oversold',    min: 5,  max: 49,  step: 1,   def: 30 },
            { key: 'overbought', label: 'Перекуп.',  en_label: 'Overbought',  min: 51, max: 95,  step: 1,   def: 70 },
        ],
        EMA:  [
            { key: 'fast', label: 'Быстрая',   en_label: 'Fast', min: 2,  max: 50,  step: 1, def: 5  },
            { key: 'slow', label: 'Медленная', en_label: 'Slow', min: 3,  max: 200, step: 1, def: 21 },
        ],
        SMA:  [
            { key: 'fast', label: 'Быстрая',   en_label: 'Fast', min: 2,  max: 50,  step: 1, def: 5  },
            { key: 'slow', label: 'Медленная', en_label: 'Slow', min: 3,  max: 200, step: 1, def: 14 },
        ],
        BB:   [
            { key: 'period', label: 'Период',    en_label: 'Period',      min: 5,   max: 100, step: 1,   def: 20 },
            { key: 'dev',    label: 'Откл. (σ)', en_label: 'Deviation σ', min: 0.5, max: 4,   step: 0.5, def: 2  },
        ],
        MACD: [
            { key: 'fast',   label: 'Быстрая EMA', en_label: 'Fast EMA', min: 2, max: 50,  step: 1, def: 12 },
            { key: 'slow',   label: 'Медл. EMA',   en_label: 'Slow EMA', min: 3, max: 200, step: 1, def: 26 },
            { key: 'signal', label: 'Сигнальн.',   en_label: 'Signal',   min: 2, max: 50,  step: 1, def: 9  },
        ],
        STOCH: [
            { key: 'kPeriod',    label: 'K период',  en_label: 'K Period',   min: 3, max: 50, step: 1, def: 14 },
            { key: 'dPeriod',    label: 'D период',  en_label: 'D Period',   min: 2, max: 20, step: 1, def: 3  },
            { key: 'oversold',   label: 'Перепрод.', en_label: 'Oversold',   min: 5, max: 45, step: 1, def: 20 },
            { key: 'overbought', label: 'Перекуп.',  en_label: 'Overbought', min: 55, max: 95, step: 1, def: 80 },
        ],
        CCI:   [
            { key: 'period', label: 'Период', en_label: 'Period', min: 5,  max: 100, step: 1,  def: 20 },
            { key: 'level',  label: 'Уровень', en_label: 'Level',  min: 50, max: 250, step: 10, def: 100 },
        ],
        TREND: [{ key: 'period', label: 'Период', en_label: 'Period', min: 2, max: 50,  step: 1, def: 5  }],
        SENTIMENT: [{ key: 'threshold', label: 'Порог %', en_label: 'Threshold %', min: 51, max: 90, step: 1, def: 60 }],
        PSAR:  [
            { key: 'fastEma', label: 'Быстрая EMA', en_label: 'Fast EMA', min: 2, max: 20, step: 1, def: 3  },
            { key: 'slowEma', label: 'Медл. EMA',   en_label: 'Slow EMA', min: 3, max: 50, step: 1, def: 10 },
        ],
    };

    // ── i18n ──────────────────────────────────────────────────────────
    let currentLang = 'ru';

    const TRANSLATIONS = {
        ru: {
            pill_stop:'СТОП', pill_run:'АНАЛИЗ', lang_btn:'🇬🇧',
            min_collapse:'Свернуть', min_expand:'Развернуть',
            act_placeholder:'Ваш ID аккаунта Pocket Option',
            act_btn:'✅ Активировать', act_checking:'Проверяю...',
            act_hint:'Где найти ID? В личном кабинете Pocket Option → Профиль',
            act_err_id:'Введите корректный ID аккаунта.',
            act_err_notfound:'Аккаунт не найден. Зарегистрируйтесь на Pocket Option по партнёрской ссылке → https://po-ru4.click/pwa?utm_campaign=773275&utm_source=affiliate&utm_medium=sr&a=rQkgoZ6yHljgTx&al=1786769&ac=optiontraderobot&cid=973082&code=WELCOME50',
            act_err_auto:'Не удалось определить ID автоматически. Введите вручную.',
            tab_signals:'Сигналы', tab_journal:'Журнал', tab_stats:'Аналитика', tab_settings:'Настройки',
            stat_signals:'Сигналов', stat_wins:'Победы', stat_losses:'Потери', stat_winrate:'Винрейт', stat_profit:'Профит',
            total_profit:'Общий результат:',
            idle_waiting:'Ожидаю сигнал...', idle_next_bet:'След. ставка:', idle_start_hint:'Запустите анализ кнопкой ниже',
            sig_buy:'ПОКУПКА', sig_sell:'ПРОДАЖА', sig_rec_bet:'Рек. ставка:',
            sig_hint:'Откройте сделку на платформе, затем отметьте результат:',
            sig_hint_expired:'⏰ Время истекло - отметьте результат сделки:',
            sig_win:'Выиграл', sig_lose:'Проиграл', sig_skip:'Пропустил',
            indicators:' индикаторов',
            btn_start:'Запустить анализ', btn_stop:'Остановить',
            log_header:'Журнал событий', log_clear:'Очистить', log_copy:'Копировать', log_copied:'Скопировано',
            jrn_no_records:'Нет записей', jrn_time:'Время', jrn_asset:'Актив', jrn_dir:'Dir', jrn_bet:'Ставка', jrn_result:'Рез.',
            jrn_reset:'🗑 Сбросить', jrn_csv:'📥 CSV',
            confirm_reset:'Сбросить всю статистику и журнал сделок?',
            csv_empty:'Журнал пуст', csv_exported:'📥 Журнал экспортирован в CSV',
            csv_headers:['Время','Актив','Направление','Ставка ($)','Результат','P&L ($)'],
            stats_reset:'🗑 Статистика сброшена',
            sec_filters:'🎯 Фильтры входа', sec_filters_hint:'(можно выбрать несколько)',
            sec_quality:'🧭 Качество входа',
            htf_filter:'Фильтр по старшему таймфрейму',
            htf_filter_hint:'Пропускает сигналы против тренда 5–30м (по экспирации). Меньше сделок, но они реже против общего движения.',
            chart_overlay:'Индикаторы на графике PO',
            chart_overlay_hint:'Синк через API PO (без кликов по меню). До 4 индикаторов: BB/EMA/RSI/MACD… Если PO отклонит create — пауза. Лучше 1–2 фильтра на график.',
            streak_guard:'Пауза после серии лоссов',
            streak_guard_limit:'Лоссов подряд', streak_guard_pause:'Пауза (мин)',
            streak_guard_hint:'Останавливает автоторговлю после N лоссов подряд, сигналы можно вести дальше вручную.',
            toast_loss_streak:'⏸ Автоторговля на паузе: серия лоссов подряд',
            toast_loss_streak_resume:'▶️ Автоторговля возобновлена после паузы',
            fm_all:'🔗 ВСЕ', fm_any:'⚡ ЛЮБОЙ', fm_ctx:'◎ КОНТЕКСТ',
            fm_any_hint:'ЛЮБОЙ: каждый совпавший фильтр открывает свою сделку. Подтверждение подбирается под стиль фильтра.',
            fm_ctx_hint:'КОНТЕКСТ: трендовые фильтры задают сторону, осцилляторы дают момент входа (откат по тренду).',
            cm_label:'Подтверждение закрытой свечи',
            cm_auto:'Авто', cm_trend:'Тренд', cm_reversion:'Разворот', cm_off:'Выкл',
            cm_hint:'Тренд - вход по продолжению движения. Разворот - вход на истощении. Авто - по стилю выбранных фильтров.',
            live_ind_title:'Фильтры на графике', live_wait_prices:'Сбор свечей',
            live_candles:'св.', live_signal_ready:'Сигнал', live_no_signal:'Нет сигнала',
            live_preview:'Выберите фильтры в настройках и запустите анализ',
            sec_ind_params:'⚙️ Параметры индикаторов',
            sec_mm:'💰 Мани-менеджмент', mm_system:'Система',
            mm_mult:'Множитель', mm_mult_win:'Множитель (WIN)', mm_mult_lose:'Множитель (LOSE)',
            mm_max_steps:'Макс. шагов', mm_parlay_steps:'Шагов парлая', mm_unit:'Единица ($)',
            sec_bets:'Параметры сделки', sec_session:'Сессия', bet_base:'Базовая ставка ($)', bet_exp:'Экспирация',
            acct_demo:'Демо', acct_real:'Реальный', acct_balance:'Баланс', bet_max:'макс.',
            exp_3sec:'3 сек', exp_15sec:'15 сек', exp_30sec:'30 сек',
            exp_1min:'1 мин.', exp_3min:'3 мин.', exp_5min:'5 мин.', exp_30min:'30 мин.', exp_1h:'1 час', exp_4h:'4 часа',
            sec_notif:'🔔 Уведомления', sound_toggle:'Звук при сигнале',
            auto_trade:'Автоторговля', auto_trade_hint:'Автоматически нажимать Покупка/Продажа при сигнале',
            risk_enable:'Ограничить Take Profit / Take Loss',
            risk_tp:'Take Profit', risk_tl:'Take Loss',
            risk_hint:'0 = лимит выключен. % считается от баланса на момент включения автоторговли',
            risk_mode_pct:'%', risk_mode_usd:'$',
            toast_low_balance:'Недостаточно средств - автоторговля отключена',
            toast_take_profit:'Take Profit достигнут - автоторговля отключена',
            toast_take_loss:'Take Loss достигнут - автоторговля отключена',
            cur_asset:'Текущая пара', cur_asset_hint:'Синхронизация с графиком Pocket Option в реальном времени',
            brand_tagline:'Конструктор сигналов',
            copyright:'PocketOption Signal v3.6.0 · pocketoption-signal.online',
            streak_wins:' победы подряд', streak_losses:' потери подряд',
            mm_step:' · шаг ',
            mm_names:{ martingale:'Мартингейл', anti_mart:'Анти-Март', fibonacci:'Фибоначчи', dalembert:"Д'Аламбер", oscar:"Oscar's Grind", parlay:'Парлай', labouchere:'Лабушер', boost:'Разгон депозита' },
            mm_boost_balance:'Стартовый баланс ($)',
            mm_boost_mult:'Множитель (проигрыш)',
            boost_cur_balance:'Текущий баланс',
            boost_tip_h:'💡 Баланс вырос!',
            boost_tip_msg:'Рекомендуем базовую ставку:',
            boost_tip_apply:'Применить',
            total_suffix:' | Всего: ', auto_suffix:' (авто)',
            tab_stats:'Аналитика',
            stat_by_asset:'📊 По активам', stat_by_ind:'🎯 По индикаторам',
            stat_strat:'Индикаторы', stats_no_data:'Нет данных для анализа',
            sec_preset:'📁 Пресеты стратегии',
            preset_hint:'Выберите экспирацию вкладкой, затем вариацию. Ставка и автоторговля не меняются.',
            preset_export:'💾 Экспорт', preset_import:'📂 Импорт',
            preset_clear:'↺ Сброс · вручную',
            preset_exported:'Пресет сохранён', preset_loaded:'Пресет загружен', preset_err:'Ошибка чтения файла',
            preset_applied:'Пресет применён',
            preset_cleared:'Пресет сброшен - настройте фильтры вручную',
            preset_clear_hint:'Снимает активный пресет и возвращает параметры индикаторов к классическим (RSI 14/30/70, MACD 12/26/9, BB 20/2 и т.д.)',
        },
        en: {
            pill_stop:'STOP', pill_run:'LIVE', lang_btn:'🇷🇺',
            min_collapse:'Minimize', min_expand:'Expand',
            act_placeholder:'Your Pocket Option account ID',
            act_btn:'✅ Activate', act_checking:'Checking...',
            act_hint:'Where to find ID? In your Pocket Option profile → Account',
            act_err_id:'Please enter a valid account ID.',
            act_err_notfound:'Account not found. Register on Pocket Option via our partner link → https://po-ru4.click/pwa?utm_campaign=773275&utm_source=affiliate&utm_medium=sr&a=rQkgoZ6yHljgTx&al=1786769&ac=optiontraderobot&cid=973082&code=WELCOME50',
            act_err_auto:'Could not detect ID automatically. Please enter it manually.',
            tab_signals:'Signals', tab_journal:'Journal', tab_stats:'Analytics', tab_settings:'Settings',
            stat_signals:'Signals', stat_wins:'Wins', stat_losses:'Losses', stat_winrate:'Win rate', stat_profit:'Profit',
            total_profit:'Total result:',
            idle_waiting:'Waiting for signal...', idle_next_bet:'Next bet:', idle_start_hint:'Start analysis with the button below',
            sig_buy:'BUY / CALL', sig_sell:'SELL / PUT', sig_rec_bet:'Rec. bet:',
            sig_hint:'Open a trade on the platform, then mark the result:',
            sig_hint_expired:'⏰ Time is up - mark your trade result:',
            sig_win:'Won', sig_lose:'Lost', sig_skip:'Skipped',
            indicators:' indicators',
            btn_start:'Start analysis', btn_stop:'Stop',
            log_header:'Event log', log_clear:'Clear', log_copy:'Copy', log_copied:'Copied',
            jrn_no_records:'No records', jrn_time:'Time', jrn_asset:'Asset', jrn_dir:'Dir', jrn_bet:'Bet', jrn_result:'Res.',
            jrn_reset:'🗑 Reset', jrn_csv:'📥 CSV',
            confirm_reset:'Reset all statistics and trade journal?',
            csv_empty:'Journal is empty', csv_exported:'📥 Journal exported to CSV',
            csv_headers:['Time','Asset','Direction','Bet ($)','Result','P&L ($)'],
            stats_reset:'🗑 Statistics reset',
            sec_filters:'🎯 Entry filters', sec_filters_hint:'(multiple allowed)',
            sec_quality:'🧭 Entry quality',
            htf_filter:'Higher-timeframe trend filter',
            htf_filter_hint:'Skips signals against the 5–30m trend (based on expiry). Fewer trades, but less against the overall move.',
            chart_overlay:'PO chart indicators',
            chart_overlay_hint:'Sync via PO API (no menu clicks). Up to 4 indicators: BB/EMA/RSI/MACD… Prefer 1–2 chart filters.',
            streak_guard:'Pause after a loss streak',
            streak_guard_limit:'Losses in a row', streak_guard_pause:'Pause (min)',
            streak_guard_hint:'Stops auto-trade after N consecutive losses; you can still trade signals manually.',
            toast_loss_streak:'⏸ Auto-trade paused: consecutive loss streak',
            toast_loss_streak_resume:'▶️ Auto-trade resumed after pause',
            fm_all:'🔗 ALL', fm_any:'⚡ ANY', fm_ctx:'◎ CONTEXT',
            fm_any_hint:'ANY: each matching filter opens its own trade. Confirmation follows that filter\'s style.',
            fm_ctx_hint:'CONTEXT: trend filters set the side, oscillators time the entry (pullback with the trend).',
            cm_label:'Closed-candle confirmation',
            cm_auto:'Auto', cm_trend:'Trend', cm_reversion:'Reversion', cm_off:'Off',
            cm_hint:'Trend - enter with continuation. Reversion - enter on exhaustion. Auto - from the selected filters\' style.',
            live_ind_title:'Chart filters', live_wait_prices:'Building candles',
            live_candles:'candles', live_signal_ready:'Signal', live_no_signal:'No signal',
            live_preview:'Select filters in settings and start analysis',
            sec_ind_params:'⚙️ Indicator parameters',
            sec_mm:'💰 Money management', mm_system:'System',
            mm_mult:'Multiplier', mm_mult_win:'Multiplier (WIN)', mm_mult_lose:'Multiplier (LOSE)',
            mm_max_steps:'Max steps', mm_parlay_steps:'Parlay steps', mm_unit:'Unit ($)',
            sec_bets:'Trade settings', sec_session:'Session', bet_base:'Base bet ($)', bet_exp:'Expiry',
            acct_demo:'Demo', acct_real:'Real', acct_balance:'Balance', bet_max:'max',
            exp_3sec:'3 sec', exp_15sec:'15 sec', exp_30sec:'30 sec',
            exp_1min:'1 min.', exp_3min:'3 min.', exp_5min:'5 min.', exp_30min:'30 min.', exp_1h:'1 hour', exp_4h:'4 hours',
            sec_notif:'🔔 Notifications', sound_toggle:'Sound on signal',
            auto_trade:'Auto-trading', auto_trade_hint:'Automatically click CALL/PUT on signal',
            risk_enable:'Limit Take Profit / Take Loss',
            risk_tp:'Take Profit', risk_tl:'Take Loss',
            risk_hint:'0 = limit off. % is calculated from balance when auto-trading is enabled',
            risk_mode_pct:'%', risk_mode_usd:'$',
            toast_low_balance:'Insufficient funds - auto-trading disabled',
            toast_take_profit:'Take Profit reached - auto-trading disabled',
            toast_take_loss:'Take Loss reached - auto-trading disabled',
            cur_asset:'Current pair', cur_asset_hint:'Real-time sync with Pocket Option chart',
            brand_tagline:'Signal builder',
            copyright:'PocketOption Signal v3.6.0 · pocketoption-signal.online',
            streak_wins:' wins in a row', streak_losses:' losses in a row',
            mm_step:' · step ',
            mm_names:{ martingale:'Martingale', anti_mart:'Anti-Martingale', fibonacci:'Fibonacci', dalembert:"D'Alembert", oscar:"Oscar's Grind", parlay:'Parlay', labouchere:'Labouchère', boost:'Deposit Boost' },
            mm_boost_balance:'Starting balance ($)',
            mm_boost_mult:'Multiplier (on loss)',
            boost_cur_balance:'Current balance',
            boost_tip_h:'💡 Balance grew!',
            boost_tip_msg:'Recommended base bet:',
            boost_tip_apply:'Apply',
            total_suffix:' | Total: ', auto_suffix:' (auto)',
            tab_stats:'Analytics',
            stat_by_asset:'📊 By asset', stat_by_ind:'🎯 By indicators',
            stat_strat:'Indicators', stats_no_data:'No data to analyse',
            sec_preset:'📁 Strategy presets',
            preset_hint:'Pick an expiry tab, then a variation. Base bet and auto-trade stay unchanged.',
            preset_export:'💾 Export', preset_import:'📂 Import',
            preset_clear:'↺ Reset · manual',
            preset_exported:'Preset saved', preset_loaded:'Preset loaded', preset_err:'Error reading file',
            preset_applied:'Preset applied',
            preset_cleared:'Preset cleared - configure filters manually',
            preset_clear_hint:'Clears the active preset and restores classic indicator defaults (RSI 14/30/70, MACD 12/26/9, BB 20/2, etc.)',
        },
    };

    function t(key) {
        var lng = TRANSLATIONS[currentLang] || TRANSLATIONS.ru;
        return lng[key] !== undefined ? lng[key] : (TRANSLATIONS.ru[key] || key);
    }

    // Флаги языка — inline SVG, а не эмодзи 🇬🇧/🇷🇺: на Windows (Chrome/WebView2, Segoe UI Emoji)
    // regional-indicator флаги не рисуются и выводятся буквами «GB»/«RU».
    var LANG_FLAG_SVG = {
        en: '<svg xmlns="http://www.w3.org/2000/svg" class="pos-flag" viewBox="0 0 60 30" width="20" height="14" preserveAspectRatio="none" aria-hidden="true"><path d="M0,0 v30 h60 v-30 z" fill="#012169"/><path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" stroke-width="6"/><path d="M0,0 L30,15 M60,0 L30,15 M60,30 L30,15 M0,30 L30,15" stroke="#C8102E" stroke-width="2.4"/><path d="M30,0 v30 M0,15 h60" stroke="#fff" stroke-width="10"/><path d="M30,0 v30 M0,15 h60" stroke="#C8102E" stroke-width="6"/></svg>',
        ru: '<svg xmlns="http://www.w3.org/2000/svg" class="pos-flag" viewBox="0 0 9 6" width="20" height="14" preserveAspectRatio="none" aria-hidden="true"><rect width="9" height="2" fill="#fff"/><rect y="2" width="9" height="2" fill="#0039A6"/><rect y="4" width="9" height="2" fill="#D52B1E"/></svg>'
    };
    function setLangFlag(btn, lang) {
        var svg = new DOMParser().parseFromString(LANG_FLAG_SVG[lang], 'image/svg+xml').documentElement;
        btn.textContent = '';
        btn.appendChild(document.importNode(svg, true));
        btn.setAttribute('aria-label', lang === 'en' ? 'English' : 'Русский');
    }
    function applyBotLang() {
        document.querySelectorAll('#pos-panel [data-i18n]').forEach(function(el) {
            el.textContent = t(el.dataset.i18n);
        });
        document.querySelectorAll('#pos-panel [data-i18n-html]').forEach(function(el) {
            var dp = new DOMParser();
            var doc = dp.parseFromString(t(el.dataset.i18nHtml), 'text/html');
            el.textContent = '';
            Array.from(doc.body.childNodes).forEach(function(n) { el.appendChild(document.importNode(n, true)); });
        });
        document.querySelectorAll('#pos-panel [data-i18n-placeholder]').forEach(function(el) {
            el.placeholder = t(el.dataset.i18nPlaceholder);
        });
        var clearPresetBtn = document.getElementById('pos-clear-preset');
        if (clearPresetBtn) clearPresetBtn.title = t('preset_clear_hint');
        var langBtn = document.getElementById('pos-lang-btn');
        if (langBtn) {
            setLangFlag(langBtn, currentLang === 'ru' ? 'en' : 'ru');
            langBtn.title = currentLang === 'ru' ? 'English' : 'Русский';
        }
        var minBtn = document.getElementById('pos-min-btn');
        if (minBtn) {
            var minimized = document.getElementById('pos-panel') && document.getElementById('pos-panel').classList.contains('minimized');
            minBtn.title = minimized ? t('min_expand') : t('min_collapse');
        }
        var pill = document.getElementById('pos-pill');
        if (pill) pill.title = pill.classList.contains('run') ? t('pill_run') : t('pill_stop');
        // Strategy card descriptions
        document.querySelectorAll('.pos-strat-card').forEach(function(card) {
            var strat = STRATEGIES.find(function(s) { return s.id === card.dataset.id; });
            if (!strat) return;
            var descEl = card.querySelector('.pos-sd');
            if (descEl) descEl.textContent = currentLang === 'en' ? (strat.en_desc || strat.desc) : strat.desc;
        });
        // MM select options
        var sel = document.getElementById('pos-mm');
        if (sel) {
            Array.from(sel.options).forEach(function(opt) {
                var mm = MM_OPTIONS.find(function(o) { return o.id === opt.value; });
                if (mm) opt.textContent = currentLang === 'en' ? (mm.en_name || mm.name) : mm.name;
            });
        }
        // Ind param labels
        document.querySelectorAll('.pos-ind-input').forEach(function(inp) {
            var meta = IND_PARAMS_META[inp.dataset.ind];
            if (!meta) return;
            var p = meta.find(function(x) { return x.key === inp.dataset.key; });
            if (!p) return;
            var lbl = inp.parentElement && inp.parentElement.querySelector('label');
            if (lbl) lbl.textContent = currentLang === 'en' ? (p.en_label || p.label) : p.label;
        });
        buildPresetGrid();
        refreshWinAppLinks();
        // Journal empty row
        var tbody = document.getElementById('qj-tbody');
        if (tbody && tbody.querySelector('.qj-none')) {
            var etr2 = document.createElement('tr');
            var etd2 = document.createElement('td');
            etd2.colSpan = 6; etd2.className = 'qj-none'; etd2.textContent = t('jrn_no_records');
            etr2.appendChild(etd2); tbody.textContent = ''; tbody.appendChild(etr2);
        }
    }

    const journal = [];
    let selectedStrategies = ['RSI'];
    let filterMode = 'ALL';
    let confirmMode = 'auto';
    let triggerPolicy = '';
    let currentSignal = null;
    let signalTimer = null;
    let signalExpirationSec = 60;

    // Таймфреймы PocketOption: S3, S15, S30, M1, M3, M5, M30, H1, H4 (M2 у PO нет).
    const PO_EXPIRATIONS = [3, 15, 30, 60, 180, 300, 1800, 3600, 14400];
    // Старые сохранённые значения: минуты (1/2/5) и убранные 2 мин → ближайшее, что есть у PO
    const LEGACY_EXPIRATIONS = { 1: 60, 2: 180, 5: 300, 120: 180 };

    function normalizeExpiration(val) {
        val = parseInt(val);
        if (!val || isNaN(val)) return 60;
        if (LEGACY_EXPIRATIONS[val]) return LEGACY_EXPIRATIONS[val];
        if (PO_EXPIRATIONS.indexOf(val) >= 0) return val;
        var best = PO_EXPIRATIONS[0];
        PO_EXPIRATIONS.forEach(function(v) { if (Math.abs(v - val) < Math.abs(best - val)) best = v; });
        return best;
    }

    function getSignalTTL() {
        if (IS_TOP) {
            var el = document.getElementById('pos-expiration');
            if (el) signalExpirationSec = normalizeExpiration(el.value);
        }
        return signalExpirationSec;
    }
    const localStats = { total: 0, wins: 0, losses: 0, totalProfit: 0, winRate: 0 };
    const currentStreak = { type: null, count: 0 };
    let _lossStreakTimer = null;
    const indConfig = {};

    const mmState = {
        strategy: 'fixed', baseBet: 1, multiplier: 2, maxSteps: 5,
        parlaySteps: 2, dalembertUnit: 1, step: 0, currentBet: 1,
        FIB: [1, 1, 2, 3, 5, 8, 13, 21, 34, 55],
        labInit: [1, 2, 3], labSeq: [1, 2, 3],
        startBalance: 1000, betPercent: 0.01,
        init: function(cfg) {
            this.strategy      = cfg.moneyManagement || 'fixed';
            this.baseBet       = parseFloat(cfg.baseBet)       || 1;
            this.multiplier    = parseFloat(cfg.multiplier)    || 2;
            this.maxSteps      = parseInt(cfg.maxSteps)        || 5;
            this.parlaySteps   = parseInt(cfg.parlaySteps)     || 2;
            this.dalembertUnit = parseFloat(cfg.dalembertUnit) || 1;
            this.labInit       = (cfg.labSequence || '1,2,3').split(',').map(function(n) { return parseFloat(n.trim()) || 1; });
            this.labSeq        = this.labInit.slice();
            this.startBalance  = parseFloat(cfg.startBalance) || 1000;
            this.betPercent    = this.startBalance > 0 ? this.baseBet / this.startBalance : 0.01;
            this.step = 0; this.currentBet = this.baseBet;
            if (this.strategy === 'labouchere') {
                var u = this.labSeq.length >= 2 ? this.labSeq[0] + this.labSeq[this.labSeq.length - 1] : (this.labSeq[0] || 1);
                this.currentBet = parseFloat((this.baseBet * u).toFixed(2));
            }
        },
        onResult: function(result) {
            var b = this.baseBet;
            switch (this.strategy) {
                case 'martingale':
                    if (result === 'LOSE') {
                        this.step++;
                        if (this.step >= this.maxSteps) { this.step = 0; this.currentBet = b; }
                        else { this.currentBet = parseFloat((this.currentBet * this.multiplier).toFixed(2)); }
                    } else { this.step = 0; this.currentBet = b; }
                    break;
                case 'anti_mart':
                    if (result === 'WIN') {
                        this.step++;
                        if (this.step >= this.maxSteps) { this.step = 0; this.currentBet = b; }
                        else { this.currentBet = parseFloat((this.currentBet * this.multiplier).toFixed(2)); }
                    } else { this.step = 0; this.currentBet = b; }
                    break;
                case 'fibonacci':
                    if (result === 'LOSE') { this.step = Math.min(this.step + 1, this.FIB.length - 1); }
                    else { this.step = Math.max(0, this.step - 2); }
                    this.currentBet = parseFloat((b * this.FIB[this.step]).toFixed(2));
                    break;
                case 'dalembert':
                    if (result === 'LOSE') { this.step++; this.currentBet = parseFloat((this.currentBet + this.dalembertUnit).toFixed(2)); }
                    else { this.step = Math.max(0, this.step - 1); this.currentBet = Math.max(b, parseFloat((this.currentBet - this.dalembertUnit).toFixed(2))); }
                    break;
                case 'oscar':
                    if (result === 'WIN') { this.step++; this.currentBet = parseFloat((this.currentBet + this.dalembertUnit).toFixed(2)); }
                    break;
                case 'parlay':
                    if (result === 'WIN') {
                        this.step++;
                        if (this.step >= this.parlaySteps) { this.step = 0; this.currentBet = b; }
                        else { this.currentBet = parseFloat((this.currentBet * 1.85).toFixed(2)); }
                    } else { this.step = 0; this.currentBet = b; }
                    break;
                case 'labouchere': {
                    var curUnits = this.labSeq.length >= 2 ? this.labSeq[0] + this.labSeq[this.labSeq.length - 1] : (this.labSeq[0] || 1);
                    if (result === 'WIN') {
                        if (this.labSeq.length >= 2) { this.labSeq.shift(); this.labSeq.pop(); }
                        else { this.labSeq = []; }
                    } else {
                        this.labSeq.push(curUnits);
                    }
                    if (this.labSeq.length === 0) this.labSeq = this.labInit.slice();
                    var nextUnits = this.labSeq.length >= 2 ? this.labSeq[0] + this.labSeq[this.labSeq.length - 1] : (this.labSeq[0] || 1);
                    this.currentBet = parseFloat((b * nextUnits).toFixed(2));
                    break;
                }
                case 'boost':
                    if (result === 'LOSE') {
                        this.step++;
                        if (this.step >= this.maxSteps) { this.step = 0; this.currentBet = b; }
                        else { this.currentBet = parseFloat((this.currentBet * this.multiplier).toFixed(2)); }
                    } else { this.step = 0; this.currentBet = b; }
                    break;
                default: this.currentBet = b;
            }
        },
        getNextBet: function() { return this.currentBet; },
        getBoostSuggestion: function(totalProfit) {
            if (this.strategy !== 'boost') return null;
            var curBalance = this.startBalance + totalProfit;
            var suggested  = parseFloat((curBalance * this.betPercent).toFixed(2));
            if (suggested > this.baseBet * 1.05) return suggested;
            return null;
        },
        getStepInfo: function() {
            var names = t('mm_names');
            if (!names[this.strategy]) return '';
            var max = (this.strategy === 'parlay') ? this.parlaySteps :
                      (this.strategy === 'martingale' || this.strategy === 'anti_mart' || this.strategy === 'boost') ? this.maxSteps : 0;
            var step = t('mm_step');
            return names[this.strategy] + (max ? step + this.step + '/' + max : step + this.step);
        }
    };

    // ── UI ──────────────────────────────────────────────────────────────
    function injectBotUI() {
        if (document.getElementById('pos-panel')) return;
        const panel = document.createElement('div');
        panel.id = 'pos-panel';
        panel.innerHTML = `
<div id="pos-header">
  <div class="pos-logo-mark" id="pos-logo-mark" title="PocketOption Signal">PoS</div>
  <div class="pos-brand-wrap">
    <div class="pos-brand-main">PocketOption Signal</div>
    <div class="pos-brand-sub" data-i18n="brand_tagline">Конструктор сигналов</div>
  </div>
  <div class="pos-hdr-actions">
    <div class="pos-pill" id="pos-pill" title="СТОП"><div class="pos-dot"></div></div>
    <button class="pos-icon-btn pos-lang-btn" id="pos-lang-btn" title="English" aria-label="English"><svg xmlns="http://www.w3.org/2000/svg" class="pos-flag" viewBox="0 0 60 30" width="20" height="14" preserveAspectRatio="none" aria-hidden="true"><path d="M0,0 v30 h60 v-30 z" fill="#012169"/><path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" stroke-width="6"/><path d="M0,0 L30,15 M60,0 L30,15 M60,30 L30,15 M0,30 L30,15" stroke="#C8102E" stroke-width="2.4"/><path d="M30,0 v30 M0,15 h60" stroke="#fff" stroke-width="10"/><path d="M30,0 v30 M0,15 h60" stroke="#C8102E" stroke-width="6"/></svg></button>
    <button class="pos-icon-btn pos-min-btn" id="pos-min-btn" title="Свернуть">🔽</button>
  </div>
</div>
<div id="pos-body">
  <div class="pos-tabs">
    <button class="pos-tab active" data-tab="trading" data-i18n="tab_signals">Сигналы</button>
    <button class="pos-tab" data-tab="journal" data-i18n="tab_journal">Журнал</button>
    <button class="pos-tab" data-tab="stats" data-i18n="tab_stats">Аналитика</button>
    <button class="pos-tab" data-tab="predictive">ПРОГНОЗ</button>
    <button class="pos-tab" data-tab="settings" data-i18n="tab_settings">Настройки</button>
  </div>

  <!-- SIGNALS TAB -->
  <div class="pos-tc active" id="pos-tab-trading">
    <div class="pos-session-stats">
      <div class="pos-session-title" data-i18n="sec_session">Сессия</div>
      <div class="pos-stats-grid">
        <div class="pos-sc"><div class="pos-sv" id="bs-total">0</div><div class="pos-sl" data-i18n="stat_signals">Сигналов</div></div>
        <div class="pos-sc"><div class="pos-sv g" id="bs-wins">0</div><div class="pos-sl" data-i18n="stat_wins">Победы</div></div>
        <div class="pos-sc"><div class="pos-sv r" id="bs-losses">0</div><div class="pos-sl" data-i18n="stat_losses">Потери</div></div>
        <div class="pos-sc"><div class="pos-sv c" id="bs-wr">0%</div><div class="pos-sl" data-i18n="stat_winrate">Винрейт</div></div>
      </div>
      <div class="pos-profit-bar">
        <span class="pos-profit-lbl" data-i18n="total_profit">Общий результат</span>
        <span id="pos-profit-val">$0.00</span>
      </div>
    </div>
    <div class="pos-asset-bar">
      <div class="pos-asset-bar-top">
        <span class="pos-asset-bar-lbl" data-i18n="cur_asset">Текущая пара</span>
        <span class="pos-asset-bar-live" id="pos-asset-live-dot" title=""></span>
      </div>
      <div class="pos-asset-bar-val" id="pos-cur-asset">-</div>
      <div class="pos-asset-bar-hint" data-i18n="cur_asset_hint">Синхронизация с графиком Pocket Option в реальном времени</div>
    </div>
    <div class="pos-sig-card neutral" id="pos-sig-card">
      <div class="pos-sig-idle" id="pos-sig-idle">
        <div class="pos-sig-idle-ring"><span class="pos-sig-idle-dot"></span></div>
        <div class="pos-sig-idle-txt" data-i18n="idle_waiting">Ожидаю сигнал...</div>
        <div class="pos-sig-idle-bet" id="pos-idle-bet" style="display:none"><span data-i18n="idle_next_bet">След. ставка:</span> <span id="pos-idle-bet-val">-</span></div>
        <div class="pos-sig-idle-sub" id="pos-idle-start-hint" data-i18n="idle_start_hint">Запустите анализ кнопкой ниже</div>
        <div class="pos-ind-live" id="pos-ind-live" style="display:none">
          <div class="pos-ind-live-hdr">
            <span data-i18n="live_ind_title">Фильтры на графике</span>
            <span class="pos-ind-live-mode" id="pos-ind-live-mode">ALL</span>
          </div>
          <div id="pos-ind-live-grid"></div>
          <div class="pos-ind-live-sum neutral" id="pos-ind-live-sum">-</div>
        </div>
      </div>
      <div class="pos-sig-active" id="pos-sig-active" style="display:none">
        <div class="pos-sig-top">
          <div class="pos-sig-arrow" id="pos-sig-arrow">-</div>
          <div class="pos-sig-meta">
            <div class="pos-sig-asset" id="pos-sig-asset">-</div>
            <div class="pos-sig-label" id="pos-sig-label">-</div>
          </div>
          <div class="pos-sig-badge" id="pos-sig-indic">-</div>
        </div>
        <div class="pos-sig-strength" id="pos-sig-strength" style="display:none">
          <span class="pos-sig-dots" id="pos-sig-dots"></span>
          <span id="pos-sig-strength-txt"></span>
        </div>
        <div class="pos-sig-bet-row">
          <span class="pos-sig-bet-lbl" data-i18n="sig_rec_bet">Рек. ставка</span>
          <span class="pos-sig-bet-val" id="pos-sig-amount">-</span>
          <span class="pos-sig-timer" id="pos-sig-timer">60с</span>
        </div>
        <div class="pos-sig-mm-row" id="pos-sig-mm-row" style="display:none">
          <span class="pos-sig-mm-txt" id="pos-sig-mm-txt">-</span>
        </div>
        <div class="pos-sig-hint" id="pos-sig-hint" data-i18n="sig_hint">Откройте сделку на платформе, затем отметьте результат</div>
        <div class="pos-sig-btns">
          <button class="pos-sig-btn win" id="pos-sig-win" data-i18n="sig_win">Выиграл</button>
          <button class="pos-sig-btn lose" id="pos-sig-lose" data-i18n="sig_lose">Проиграл</button>
          <button class="pos-sig-btn skip" id="pos-sig-skip" data-i18n="sig_skip">Пропустил</button>
        </div>
      </div>
    </div>
    <button class="pos-btn-main start" id="pos-start-btn" data-i18n="btn_start">Запустить анализ</button>
    <button class="pos-btn-main stop hidden" id="pos-stop-btn" data-i18n="btn_stop">Остановить</button>
    <div class="pos-auto-card">
      <label class="pos-auto-trade-row" for="pos-auto-trade">
        <span class="pos-auto-trade-copy">
          <span class="pos-auto-trade-title" data-i18n="auto_trade">Автоторговля</span>
          <span class="pos-auto-trade-sub" data-i18n="auto_trade_hint">Автоматически нажимать Покупка/Продажа при сигнале</span>
        </span>
        <span class="pos-switch">
          <input type="checkbox" id="pos-auto-trade" role="switch" aria-checked="false">
          <span class="pos-switch-ui" aria-hidden="true">
            <span class="pos-switch-knob"></span>
          </span>
        </span>
      </label>
      <div class="pos-multi-pair-settings">
        <label class="pos-toggle-row" for="pos-multi-pair">
          <span>Сканировать все валютные пары</span>
          <span class="pos-switch pos-switch-sm">
            <input type="checkbox" id="pos-multi-pair" checked>
            <span class="pos-switch-ui" aria-hidden="true"><span class="pos-switch-knob"></span></span>
          </span>
        </label>
        <div class="pos-frow">
          <div class="pos-fg">
            <label for="pos-min-profit">Минимальная доходность (%)</label>
            <input type="number" id="pos-min-profit" min="0" max="100" step="1" value="92">
          </div>
          <div class="pos-fg">
            <label for="pos-max-concurrent">Макс. одновременных сделок</label>
            <input type="number" id="pos-max-concurrent" min="1" max="20" step="1" value="4">
          </div>
        </div>
        <label class="pos-toggle-row" for="pos-include-otc">
          <span>Включать OTC-пары</span>
          <span class="pos-switch pos-switch-sm">
            <input type="checkbox" id="pos-include-otc" checked>
            <span class="pos-switch-ui" aria-hidden="true"><span class="pos-switch-knob"></span></span>
          </span>
        </label>
        <div class="pos-reverse-card">
          <label class="pos-toggle-row" for="pos-reverse-enabled">
            <span><b>REVERS</b><small>После серии побед менять направление на противоположное</small></span>
            <span class="pos-switch pos-switch-sm">
              <input type="checkbox" id="pos-reverse-enabled" role="switch" aria-checked="false">
              <span class="pos-switch-ui" aria-hidden="true"><span class="pos-switch-knob"></span></span>
            </span>
          </label>
          <div class="pos-fg">
            <label for="pos-reverse-wins">Переключать после побед подряд: <b id="pos-reverse-wins-value">3</b></label>
            <input type="range" id="pos-reverse-wins" min="1" max="10" step="1" value="3" style="width:100%">
          </div>
          <div class="pos-risk-hint">После достижения порога бот переключает режим. Следующая такая же серия побед переключит его обратно. Поражение сбрасывает счётчик серии.</div>
        </div>
        <div class="pos-risk-hint">Для одновременных сделок используется фиксированная базовая ставка; прогрессивный мани-менеджмент не применяется.</div>
      </div>
      <label class="pos-toggle-row pos-risk-enable-row" for="pos-risk-enable">
        <span data-i18n="risk_enable">Ограничить Take Profit / Take Loss</span>
        <span class="pos-switch pos-switch-sm">
          <input type="checkbox" id="pos-risk-enable" role="switch" aria-checked="false">
          <span class="pos-switch-ui" aria-hidden="true">
            <span class="pos-switch-knob"></span>
          </span>
        </span>
      </label>
      <div class="pos-risk-wrap" id="pos-risk-wrap" style="display:none">
        <div class="pos-risk-list">
          <div class="pos-risk-row is-tp">
            <div class="pos-risk-row-head">
              <span class="pos-risk-lbl" data-i18n="risk_tp">Take Profit</span>
              <div class="pos-risk-seg" id="pos-tp-seg" role="group" aria-label="Take Profit unit">
                <button type="button" class="pos-risk-seg-btn active" data-value="percent">%</button>
                <button type="button" class="pos-risk-seg-btn" data-value="amount">$</button>
              </div>
            </div>
            <input type="hidden" id="pos-tp-mode" value="percent">
            <div class="pos-risk-input-wrap">
              <input type="number" id="pos-tp-val" min="0" step="0.1" value="0" placeholder="0">
              <span class="pos-risk-unit" id="pos-tp-unit">%</span>
            </div>
          </div>
          <div class="pos-risk-row is-tl">
            <div class="pos-risk-row-head">
              <span class="pos-risk-lbl" data-i18n="risk_tl">Take Loss</span>
              <div class="pos-risk-seg" id="pos-tl-seg" role="group" aria-label="Take Loss unit">
                <button type="button" class="pos-risk-seg-btn active" data-value="percent">%</button>
                <button type="button" class="pos-risk-seg-btn" data-value="amount">$</button>
              </div>
            </div>
            <input type="hidden" id="pos-tl-mode" value="percent">
            <div class="pos-risk-input-wrap">
              <input type="number" id="pos-tl-val" min="0" step="0.1" value="0" placeholder="0">
              <span class="pos-risk-unit" id="pos-tl-unit">%</span>
            </div>
          </div>
        </div>
        <div class="pos-risk-hint" data-i18n="risk_hint">0 = выкл. % считается от баланса на момент включения автоторговли</div>
      </div>
    </div>
    <div class="pos-quick-controls">
      <div class="pos-quick-title" data-i18n="sec_bets">Параметры сделки</div>
      <div class="pos-account-bar" id="pos-account-bar">
        <span class="pos-account-badge demo" id="pos-account-type">DEMO</span>
        <span class="pos-account-bal-wrap"><span data-i18n="acct_balance">Баланс</span>: <strong id="pos-account-bal">-</strong></span>
      </div>
      <div class="pos-frow">
        <div class="pos-fg"><label data-i18n="bet_base">Базовая ставка ($)</label><input type="number" id="pos-base-bet" value="1" min="1" step="0.5"><div class="pos-bet-max-hint" id="pos-bet-max-hint"></div></div>
        <div class="pos-fg"><label data-i18n="bet_exp">Экспирация</label><select id="pos-expiration">
          <option value="3" data-i18n="exp_3sec">3 сек</option>
          <option value="15" data-i18n="exp_15sec">15 сек</option>
          <option value="30" data-i18n="exp_30sec">30 сек</option>
          <option value="60" data-i18n="exp_1min" selected>1 мин.</option>
          <option value="180" data-i18n="exp_3min">3 мин.</option>
          <option value="300" data-i18n="exp_5min">5 мин.</option>
          <option value="1800" data-i18n="exp_30min">30 мин.</option>
          <option value="3600" data-i18n="exp_1h">1 час</option>
          <option value="14400" data-i18n="exp_4h">4 часа</option>
        </select></div>
      </div>
    </div>
    <div class="pos-streak-row" id="pos-streak-row" style="display:none">
      <span id="pos-streak-icon">🔥</span>
      <span id="pos-streak-txt"></span>
    </div>
    <div id="pos-boost-info" class="pos-info-card pos-info-balance" style="display:none"><span data-i18n="boost_cur_balance">Текущий баланс</span>: <strong id="pos-boost-bal">-</strong></div>
    <div id="pos-boost-tip" class="pos-info-card pos-info-tip" style="display:none">
      <div class="pos-info-tip-title" data-i18n="boost_tip_h">Баланс вырос</div>
      <div><span data-i18n="boost_tip_msg">Рекомендуем базовую ставку:</span> <strong id="pos-boost-tip-val">-</strong></div>
      <button id="pos-boost-apply" class="pos-info-tip-btn" data-i18n="boost_tip_apply">Применить</button>
    </div>
    <div class="pos-log-hdr"><span data-i18n="log_header">Журнал событий</span><div class="pos-log-actions"><button id="pos-copy-log" data-i18n="log_copy">Копировать</button><button id="pos-clear-log" data-i18n="log_clear">Очистить</button></div></div>
    <div id="pos-log"></div>
  </div>

  <!-- JOURNAL TAB -->
  <div class="pos-tc" id="pos-tab-journal">
    <div class="qj-sum">
      <div class="pos-sc"><div class="pos-sv" id="qj-total">0</div><div class="pos-sl" data-i18n="stat_signals">Сигналов</div></div>
      <div class="pos-sc"><div class="pos-sv g" id="qj-wins">0</div><div class="pos-sl" data-i18n="stat_wins">Победы</div></div>
      <div class="pos-sc"><div class="pos-sv r" id="qj-losses">0</div><div class="pos-sl" data-i18n="stat_losses">Потери</div></div>
      <div class="pos-sc"><div class="pos-sv c" id="qj-profit">$0</div><div class="pos-sl" data-i18n="stat_profit">Профит</div></div>
    </div>
    <div class="qj-reset-row">
      <button id="pos-reset-stats" class="pos-reset-btn" data-i18n="jrn_reset">🗑 Сбросить</button>
      <button id="pos-export-csv" class="pos-reset-btn" data-i18n="jrn_csv">📥 CSV</button>
    </div>
    <div class="qj-wrap">
      <table class="qj-table">
        <thead><tr><th data-i18n="jrn_time">Время</th><th data-i18n="jrn_asset">Актив</th><th data-i18n="jrn_dir">Dir</th><th data-i18n="jrn_bet">Ставка</th><th data-i18n="jrn_result">Рез.</th><th>P&L</th></tr></thead>
        <tbody id="qj-tbody"><tr><td colspan="6" class="qj-none" data-i18n="jrn_no_records">Нет записей</td></tr></tbody>
      </table>
    </div>
  </div>

  <!-- STATS TAB -->
  <div class="pos-tc" id="pos-tab-stats">
    <div class="qbs">
      <div class="qbs-ttl" data-i18n="stat_by_asset">📊 По активам</div>
      <div id="pos-asset-stats-wrap"><div class="qj-none" data-i18n="stats_no_data">Нет данных для анализа</div></div>
    </div>
    <div class="qbs">
      <div class="qbs-ttl" data-i18n="stat_by_ind">🎯 По индикаторам</div>
      <div id="pos-ind-stats-wrap"><div class="qj-none" data-i18n="stats_no_data">Нет данных для анализа</div></div>
    </div>
  </div>

  <!-- PREDICTIVE ENGINE TAB -->
  <div class="pos-tc" id="pos-tab-predictive">
    <div class="pt4-card">
      <div class="pt4-heading"><strong>Predictive Chart Engine</strong><span id="pt4-feed-status" class="pt4-status">ОЖИДАНИЕ OTC</span></div>
      <div class="pt4-controls">
        <label>Пара<select id="pt4-asset" class="pt4-input"><option value="*">Все OTC · последний актив</option></select></label>
        <label>Экспирация<select id="pt4-horizon" class="pt4-input"><option value="60">1 мин</option><option value="120">2 мин</option><option value="180">3 мин</option><option value="240">4 мин</option><option value="300">5 мин</option></select></label>
        <label>Источник сигналов<select id="pt4-source" class="pt4-input"><option value="formula">Predictive Formula</option><option value="indicators">Только индикаторы</option><option value="combined">Комбинированный</option></select></label>
        <label>Модель<select id="pt4-model" class="pt4-input"><option value="auto">Автовыбор</option><option value="linear">Линейная</option><option value="exponential">Экспоненциальная</option><option value="polynomial">Полиномиальная</option><option value="momentum">Momentum</option><option value="cyclical">Циклическая</option><option value="ensemble">Комбинированная</option></select></label>
      </div>
      <div class="pt4-controls pt4-controls-3">
        <label>Мин. уверенность <strong id="pt4-confidence-value">60%</strong><input id="pt4-confidence" class="pt4-input" type="range" min="50" max="95" step="1" value="60"></label>
        <label>Счёт<select id="pt4-account" class="pt4-input"><option value="demo">DEMO</option><option value="real">REAL</option></select></label>
        <label>Ставка ($)<input id="pt4-stake" class="pt4-input" type="number" min="1" max="100000" step="0.5" value="1"></label>
      </div>
      <div class="pt4-controls pt4-controls-2">
        <label>Макс. одновременных сделок<input id="pt4-max-trades" class="pt4-input" type="number" min="1" max="20" step="1" value="1"></label>
        <label class="pt4-check"><input id="pt4-auto-trade" type="checkbox"> Автоторговля по прогнозу</label>
      </div>
      <div class="pt4-actions"><button id="pt4-save" type="button">СОХРАНИТЬ НАСТРОЙКИ</button><span id="pt4-signal-status">Сигналы не активны</span></div>
    </div>
    <div class="pt4-card">
      <div class="pt4-heading"><strong id="pt4-current-asset">Ожидание котировок</strong><span id="pt4-issued-at">—</span></div>
      <div class="pt4-quote-grid">
        <div><small>ТЕКУЩАЯ ЦЕНА</small><b id="pt4-current-price">—</b></div>
        <div><small>ПРОГНОЗ</small><b id="pt4-target-price">—</b></div>
        <div><small>НАПРАВЛЕНИЕ</small><b id="pt4-direction">—</b></div>
        <div><small>УВЕРЕННОСТЬ</small><b id="pt4-confidence-out">—</b></div>
      </div>
      <canvas id="pt4-chart" width="680" height="240" aria-label="График прогнозной траектории"></canvas>
      <div id="pt4-chart-legend" class="pt4-legend">Прогнозные точки фиксируются при выпуске и не перерисовываются задним числом.</div>
    </div>
    <div class="pt4-card">
      <div class="pt4-heading"><strong>Модели и независимая статистика</strong><span id="pt4-sample-count">0 проверок</span></div>
      <div class="pt4-table-wrap"><table class="pt4-table"><thead><tr><th>Модель</th><th>Цена</th><th>Напр.</th><th>Точность</th><th>N</th><th>MAE</th><th>Brier</th></tr></thead><tbody id="pt4-model-rows"><tr><td colspan="7">Ожидание первых прогнозов</td></tr></tbody></table></div>
      <div class="pt4-footnote">Точность считается только по завершённым прогнозам. При недостаточной выборке значение не показывается.</div>
      <div id="pt4-last-result" class="pt4-footnote">Последняя фактическая проверка: —</div>
    </div>
  </div>

  <!-- SETTINGS TAB -->
  <div class="pos-tc" id="pos-tab-settings">
    <div class="qbs">
      <div class="qbs-ttl"><span data-i18n="sec_filters">🎯 Фильтры входа</span> <span class="pos-strat-hint" data-i18n="sec_filters_hint">(можно выбрать несколько)</span></div>
      <div class="pos-filter-mode">
        <button class="pos-fm-btn active" id="pos-fm-all" data-mode="ALL" data-i18n="fm_all">🔗 ВСЕ</button>
        <button class="pos-fm-btn" id="pos-fm-ctx" data-mode="CONTEXT" data-i18n="fm_ctx">◎ КОНТЕКСТ</button>
        <button class="pos-fm-btn" id="pos-fm-any" data-mode="ANY" data-i18n="fm_any">⚡ ЛЮБОЙ</button>
      </div>
      <div class="pos-fm-any-hint" id="pos-fm-any-hint" style="display:none" data-i18n="fm_any_hint">ЛЮБОЙ: каждый совпавший фильтр открывает свою сделку</div>
      <div class="pos-fm-any-hint" id="pos-fm-ctx-hint" style="display:none" data-i18n="fm_ctx_hint">КОНТЕКСТ: тренд задаёт сторону, осциллятор - вход</div>
      <div class="pos-strat-grid" id="pos-strat-grid"></div>
    </div>
    <div class="qbs">
      <div class="qbs-ttl" data-i18n="sec_quality">🧭 Качество входа</div>
      <div class="pos-cm-label" data-i18n="cm_label">Подтверждение закрытой свечи</div>
      <div class="pos-filter-mode pos-confirm-mode" id="pos-confirm-mode">
        <button type="button" class="pos-fm-btn pos-cm-btn active" data-mode="auto" data-i18n="cm_auto">Авто</button>
        <button type="button" class="pos-fm-btn pos-cm-btn" data-mode="trend" data-i18n="cm_trend">Тренд</button>
        <button type="button" class="pos-fm-btn pos-cm-btn" data-mode="reversion" data-i18n="cm_reversion">Разворот</button>
        <button type="button" class="pos-fm-btn pos-cm-btn" data-mode="off" data-i18n="cm_off">Выкл</button>
      </div>
      <div class="pos-preset-hint" data-i18n="cm_hint">Тренд - вход по продолжению. Разворот - на истощении. Авто - по стилю фильтров.</div>
      <label class="pos-toggle-row" for="pos-htf-filter" style="margin-top:10px">
        <span data-i18n="htf_filter">Фильтр по старшему таймфрейму</span>
        <span class="pos-switch pos-switch-sm">
          <input type="checkbox" id="pos-htf-filter" role="switch" aria-checked="false">
          <span class="pos-switch-ui" aria-hidden="true"><span class="pos-switch-knob"></span></span>
        </span>
      </label>
      <div class="pos-preset-hint" data-i18n="htf_filter_hint">Пропускает сигналы против тренда 5–30м (по экспирации). Меньше сделок, но они реже против общего движения.</div>
      <label class="pos-toggle-row" style="margin-top:10px">
        <span data-i18n="chart_overlay">Индикаторы на графике PO</span>
        <span class="pos-switch pos-switch-sm">
          <input type="checkbox" id="pos-chart-ind-sync" role="switch" aria-checked="false">
          <span class="pos-switch-ui" aria-hidden="true"><span class="pos-switch-knob"></span></span>
        </span>
      </label>
      <div class="pos-preset-hint" data-i18n="chart_overlay_hint">Синк через API PO (без кликов по меню). До 4 индикаторов: BB/EMA/RSI/MACD… Если PO отклонит create — пауза. Лучше 1–2 фильтра на график.</div>
      <label class="pos-toggle-row" style="margin-top:10px" for="pos-streak-guard">
        <span data-i18n="streak_guard">Пауза после серии лоссов</span>
        <span class="pos-switch pos-switch-sm">
          <input type="checkbox" id="pos-streak-guard" role="switch" aria-checked="false">
          <span class="pos-switch-ui" aria-hidden="true"><span class="pos-switch-knob"></span></span>
        </span>
      </label>
      <div class="pos-streak-guard-row" id="pos-streak-guard-row" style="display:none">
        <div class="pos-fg"><label data-i18n="streak_guard_limit">Лоссов подряд</label><input type="number" id="pos-streak-limit" value="3" min="2" max="10" step="1"></div>
        <div class="pos-fg"><label data-i18n="streak_guard_pause">Пауза (мин)</label><input type="number" id="pos-streak-pause" value="10" min="1" max="120" step="1"></div>
      </div>
      <div class="pos-preset-hint" data-i18n="streak_guard_hint">Останавливает автоторговлю после N лоссов подряд, сигналы можно вести дальше вручную.</div>
    </div>
    <div class="qbs" id="pos-ind-params-section" style="display:none">
      <div class="qbs-ttl" data-i18n="sec_ind_params">⚙️ Параметры индикаторов</div>
      <div id="pos-ind-params-grid"></div>
    </div>
    <div class="qbs">
      <div class="qbs-ttl" data-i18n="sec_mm">💰 Мани-менеджмент</div>
      <div class="pos-frow full"><div class="pos-fg"><label data-i18n="mm_system">Система</label><select id="pos-mm"></select></div></div>
      <div id="pos-mm-extra" style="display:none"><div class="pos-frow">
        <div class="pos-fg" id="pos-mult-grp" style="display:none"><label id="pos-mult-lbl" data-i18n="mm_mult">Множитель</label><input type="number" id="pos-mult" value="2" min="1.1" step="0.1"></div>
        <div class="pos-fg" id="pos-maxsteps-grp" style="display:none"><label data-i18n="mm_max_steps">Макс. шагов</label><input type="number" id="pos-max-steps" value="5" min="1" max="10"></div>
        <div class="pos-fg" id="pos-steps-grp" style="display:none"><label data-i18n="mm_parlay_steps">Шагов парлая</label><input type="number" id="pos-steps" value="2" min="2" max="10"></div>
        <div class="pos-fg" id="pos-unit-grp" style="display:none"><label data-i18n="mm_unit">Единица ($)</label><input type="number" id="pos-unit" value="1" min="0.5" step="0.5"></div>
        <div class="pos-fg full" id="pos-lab-grp" style="display:none"><label data-i18n="mm_lab_seq">Последовательность (1,2,3)</label><input type="text" id="pos-lab-seq" value="1,2,3" style="width:100%;box-sizing:border-box"></div>
        <div class="pos-fg full" id="pos-boost-grp" style="display:none"><label data-i18n="mm_boost_balance">Стартовый баланс ($)</label><input type="number" id="pos-boost-balance" value="1000" min="10" step="10"></div>
      </div></div>
    </div>
    <div class="qbs">
      <div class="qbs-ttl" data-i18n="sec_notif">🔔 Уведомления</div>
      <label class="pos-toggle-row" for="pos-sound-toggle">
        <span data-i18n="sound_toggle">Звук при сигнале</span>
        <span class="pos-switch pos-switch-sm">
          <input type="checkbox" id="pos-sound-toggle" role="switch" aria-checked="true" checked>
          <span class="pos-switch-ui" aria-hidden="true"><span class="pos-switch-knob"></span></span>
        </span>
      </label>
    </div>
    <div class="qbs">
      <div class="qbs-ttl" data-i18n="sec_preset">📁 Пресеты стратегии</div>
      <div class="pos-preset-hint" id="pos-preset-hint" data-i18n="preset_hint">Выберите экспирацию вкладкой, затем вариацию. Ставка и автоторговля не меняются.</div>
      <div class="pos-preset-tabs" id="pos-preset-tabs" role="tablist"></div>
      <div class="pos-preset-grid" id="pos-preset-grid" role="tabpanel"></div>
      <div class="pos-frow" style="margin-top:10px">
        <button class="pos-reset-btn" id="pos-export-preset" style="flex:1" data-i18n="preset_export">💾 Экспорт</button>
        <button class="pos-reset-btn" id="pos-import-preset-btn" style="flex:1" data-i18n="preset_import">📂 Импорт</button>
        <button class="pos-reset-btn pos-preset-clear-btn" id="pos-clear-preset" style="flex:1" data-i18n="preset_clear" title="Сброс пресета">↺ Сброс · вручную</button>
        <input type="file" id="pos-import-preset-file" accept=".json" style="display:none">
      </div>
      <div class="pos-preset-hint" data-i18n="preset_clear_hint">Снимает активный пресет и возвращает параметры индикаторов к классическим (RSI 14/30/70, MACD 12/26/9, BB 20/2 и т.д.)</div>
    </div>
  </div>

  <div class="pos-toast" id="pos-toast" hidden></div>
</div>`;
        document.body.appendChild(panel);
        makeDraggable(panel, document.getElementById('pos-header'));
        initTabs();
        buildStrategyGrid();
        bindConfirmMode();

        buildPresetGrid();
        buildMMSelect();
        bindButtons();
        loadSettings();
        initDebugTrigger();
        // activation gate
        // Language button
        document.getElementById('pos-lang-btn').addEventListener('click', function() {
            currentLang = currentLang === 'ru' ? 'en' : 'ru';
            applyBotLang();
            if (typeof refreshAllBalanceDisplays === 'function') refreshAllBalanceDisplays();
            if (typeof chrome !== 'undefined' && chrome.storage) chrome.storage.local.set({ pos_lang: currentLang });
        });
        document.getElementById('pos-body').style.display = 'flex';
    }

    // ── TABS ──────────────────────────────────────────────────────────
    function initTabs() {
        document.querySelectorAll('.pos-tab').forEach(function(tab) {
            tab.addEventListener('click', function() {
                document.querySelectorAll('.pos-tab').forEach(function(t) { t.classList.remove('active'); });
                document.querySelectorAll('.pos-tc').forEach(function(c) { c.classList.remove('active'); });
                tab.classList.add('active');
                document.getElementById('pos-tab-' + tab.dataset.tab).classList.add('active');
                if (tab.dataset.tab === 'stats') { renderAssetStats(); renderIndStats(); }
                if (tab.dataset.tab === 'predictive') renderPredictivePanel();
            });
        });
        initPredictiveUI();
        document.getElementById('pos-min-btn').addEventListener('click', function() {
            var p = document.getElementById('pos-panel');
            p.classList.toggle('minimized');
            var minimized = p.classList.contains('minimized');
            var btn = document.getElementById('pos-min-btn');
            btn.textContent = minimized ? '🔼' : '🔽';
            btn.title = minimized ? t('min_expand') : t('min_collapse');
        });
    }

    function sendCoreCmd(detail) {
        var payload = { type: 'POROBOT_CORE_CMD', cmd: detail.cmd };
        if (detail.config) payload.config = detail.config;
        if (detail.patch) payload.patch = detail.patch;
        if (detail.enabled != null) payload.enabled = detail.enabled;
        try {
            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
                chrome.runtime.sendMessage(payload);
            } else {
                window.postMessage(payload, '*');
            }
        } catch (_) {
            try { window.postMessage(payload, '*'); } catch(_2) {}
        }
    }

    function patchRunningConfig(patch) {
        sendCoreCmd({ cmd: 'PATCH_CONFIG', patch: patch });
    }

    function syncChartOverlayToCore() {
        var el = document.getElementById('pos-chart-ind-sync');
        var on = !!(el && el.checked);
        var cfgInd = {};
        document.querySelectorAll('.pos-ind-input').forEach(function(inp) {
            var ind = inp.dataset.ind, key = inp.dataset.key;
            if (!cfgInd[ind]) cfgInd[ind] = {};
            cfgInd[ind][key] = parseFloat(inp.value) || 0;
        });
        sendCoreCmd({
            cmd: 'SET_OVERLAY',
            enabled: on,
            patch: {
                chartOverlay: on,
                indicators: selectedStrategies.slice(),
                indicator: selectedStrategies[0] || 'RSI',
                indConfig: Object.keys(cfgInd).length ? cfgInd : indConfig,
                expiration: normalizeExpiration(document.getElementById('pos-expiration') && document.getElementById('pos-expiration').value)
            }
        });
        try { appendLog(on ? '📉 Синк индикаторов PO включён' : '📉 Синк индикаторов PO выключен'); } catch (_) {}
    }

    function setLiveBoardVisible(on) {
        var live = document.getElementById('pos-ind-live');
        if (live) live.style.display = on ? 'block' : 'none';
        if (!on) {
            var grid = document.getElementById('pos-ind-live-grid');
            var sum = document.getElementById('pos-ind-live-sum');
            if (grid) grid.innerHTML = '';
            if (sum) sum.textContent = '-';
        }
    }

    function buildLiveScanStub() {
        var exp = normalizeExpiration(document.getElementById('pos-expiration') && document.getElementById('pos-expiration').value);
        return {
            filterMode: filterMode,
            indicators: selectedStrategies.map(function(id) { return { id: id, signal: 'NEUTRAL' }; }),
            direction: 'NEUTRAL',
            matchedCount: 0,
            totalCount: selectedStrategies.length,
            priceCount: 0,
            tickCount: 0,
            minRequired: exp <= 15 ? 12 : exp <= 60 ? 18 : 22,
            candleSec: exp,
            ready: false,
            preview: !window._posRunning
        };
    }

    function refreshLiveBoard() {
        if (!window._posRunning) {
            setLiveBoardVisible(false);
            return;
        }
        updateLiveScan(buildLiveScanStub());
    }

    function updateLiveScan(data) {
        if (!data) return;
        var live = document.getElementById('pos-ind-live');
        if (!live) return;

        if (!window._posRunning && !data.preview) {
            live.style.display = 'none';
            return;
        }
        live.style.display = 'block';

        var modeEl = document.getElementById('pos-ind-live-mode');
        if (modeEl) {
            modeEl.textContent = data.filterMode === 'ANY' ? t('fm_any')
                : data.filterMode === 'CONTEXT' ? t('fm_ctx')
                : t('fm_all');
        }

        var grid = document.getElementById('pos-ind-live-grid');
        if (!grid) return;
        grid.innerHTML = '';

        var indList = (data.indicators && data.indicators.length)
            ? data.indicators
            : selectedStrategies.map(function(id) { return { id: id, signal: 'NEUTRAL' }; });

        if (currentSignal) {
            live.style.display = 'none';
            return;
        }

        indList.forEach(function(item) {
            var strat = STRATEGIES.find(function(s) { return s.id === item.id; });
            var row = document.createElement('div');
            row.className = 'qbs-row';
            var lbl = document.createElement('div');
            lbl.className = 'qbs-label';
            lbl.textContent = strat ? (strat.icon + ' ' + strat.name) : item.id;
            var barWrap = document.createElement('div');
            barWrap.className = 'qbs-bar-wrap';
            var bar = document.createElement('div');
            bar.className = 'qbs-bar';
            var val = document.createElement('div');
            val.className = 'qbs-val';
            if (item.signal === 'UP') {
                bar.style.width = '100%';
                bar.style.background = 'var(--q-up)';
                val.textContent = '▲';
                val.style.color = 'var(--q-up)';
            } else if (item.signal === 'DOWN') {
                bar.style.width = '100%';
                bar.style.background = 'var(--q-down)';
                val.textContent = '▼';
                val.style.color = 'var(--q-down)';
            } else {
                bar.style.width = '30%';
                bar.style.background = 'var(--q-dim)';
                val.textContent = '-';
                val.style.color = 'var(--q-dim)';
            }
            barWrap.appendChild(bar);
            row.appendChild(lbl);
            row.appendChild(barWrap);
            row.appendChild(val);
            grid.appendChild(row);
        });

        var sum = document.getElementById('pos-ind-live-sum');
        if (!sum) return;
        var minReq = data.minRequired || 15;
        var candleSec = data.candleSec || signalExpirationSec;
        if (data.preview) {
            sum.textContent = t('live_preview');
            sum.className = 'pos-ind-live-sum wait';
        } else if (!data.ready) {
            sum.textContent = t('live_wait_prices') + ' ' + (data.priceCount || 0) + '/' + minReq +
                ' (' + candleSec + t('live_candles') + ')';
            sum.className = 'pos-ind-live-sum wait';
        } else if (data.direction === 'UP' || data.direction === 'DOWN') {
            sum.textContent = (data.direction === 'UP' ? '▲ ' : '▼ ') + t('live_signal_ready') +
                ' · ' + data.matchedCount + '/' + data.totalCount;
            sum.className = 'pos-ind-live-sum ' + (data.direction === 'UP' ? 'up' : 'down');
        } else {
            sum.textContent = t('live_no_signal') + ' · ' + data.matchedCount + '/' + data.totalCount;
            sum.className = 'pos-ind-live-sum neutral';
        }
    }

    // ── STRATEGY GRID ─────────────────────────────────────────────────
    function buildStrategyGrid() {
        var grid = document.getElementById('pos-strat-grid');
        STRATEGIES.forEach(function(s) {
            var card = document.createElement('div');
            card.className = 'pos-strat-card' + (selectedStrategies.indexOf(s.id) >= 0 ? ' sel' : '');
            card.dataset.id = s.id;
            var si = document.createElement('div'); si.className = 'pos-si'; si.textContent = s.icon;
            var sn = document.createElement('div'); sn.className = 'pos-sn'; sn.textContent = s.name;
            var sd = document.createElement('div'); sd.className = 'pos-sd'; sd.textContent = s.desc;
            var si2 = document.createElement('div'); si2.appendChild(sn); si2.appendChild(sd);
            card.appendChild(si); card.appendChild(si2);
            card.addEventListener('click', function() {
                var idx = selectedStrategies.indexOf(s.id);
                if (idx >= 0) {
                    if (selectedStrategies.length > 1) { selectedStrategies.splice(idx, 1); card.classList.remove('sel'); }
                } else {
                    selectedStrategies.push(s.id); card.classList.add('sel');
                }
                if (activeBuiltinPresetId) {
                    activeBuiltinPresetId = null;
                    buildPresetGrid();
                }
                renderIndParams();
                patchRunningConfig({
                    indicators: selectedStrategies.slice(),
                    indicator: selectedStrategies[0] || 'RSI'
                });
                saveSettings();
                refreshLiveBoard();
            });
            grid.appendChild(card);
        });
        // Filter mode buttons
        document.querySelectorAll('.pos-fm-btn:not(.pos-cm-btn)').forEach(function(btn) {
            btn.addEventListener('click', function() {
                filterMode = btn.dataset.mode;
                document.querySelectorAll('.pos-fm-btn:not(.pos-cm-btn)').forEach(function(b) { b.classList.remove('active'); });
                btn.classList.add('active');
                if (activeBuiltinPresetId) {
                    activeBuiltinPresetId = null;
                    buildPresetGrid();
                }
                patchRunningConfig({ filterMode: filterMode });
                saveSettings();
                refreshLiveBoard();
                updateFilterModeHint();
            });
        });
        updateFilterModeHint();
    }

    function updateFilterModeHint() {
        var anyHint = document.getElementById('pos-fm-any-hint');
        var ctxHint = document.getElementById('pos-fm-ctx-hint');
        if (anyHint) anyHint.style.display = filterMode === 'ANY' ? 'block' : 'none';
        if (ctxHint) ctxHint.style.display = filterMode === 'CONTEXT' ? 'block' : 'none';
    }

    function setConfirmModeUI(mode) {
        confirmMode = ['auto', 'trend', 'reversion', 'off'].indexOf(mode) >= 0 ? mode : 'auto';
        document.querySelectorAll('.pos-cm-btn').forEach(function(b) {
            b.classList.toggle('active', b.dataset.mode === confirmMode);
        });
    }

    function bindConfirmMode() {
        document.querySelectorAll('.pos-cm-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                setConfirmModeUI(btn.dataset.mode);
                if (activeBuiltinPresetId) {
                    activeBuiltinPresetId = null;
                    buildPresetGrid();
                }
                patchRunningConfig({ confirmMode: confirmMode });
                saveSettings({ confirmMode: confirmMode });
            });
        });
    }

    // ── MM SELECT ─────────────────────────────────────────────────────
    function buildMMSelect() {
        var sel = document.getElementById('pos-mm');
        MM_OPTIONS.forEach(function(opt) {
            var o = document.createElement('option');
            o.value = opt.id; o.textContent = opt.name;
            sel.appendChild(o);
        });
        sel.addEventListener('change', function() { updateMMExtra(); onMMSettingsChange(); });
        updateMMExtra();
        ['pos-mult', 'pos-max-steps', 'pos-steps', 'pos-unit', 'pos-lab-seq'].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.addEventListener('change', onMMSettingsChange);
        });
    }

    function collectMMSettings() {
        var el = function(id) { return document.getElementById(id) || {}; };
        return {
            moneyManagement: el('pos-mm').value || 'fixed',
            multiplier:      parseFloat(el('pos-mult').value)     || 2,
            maxSteps:        parseInt(el('pos-max-steps').value)  || 5,
            parlaySteps:     parseInt(el('pos-steps').value)      || 2,
            dalembertUnit:   parseFloat(el('pos-unit').value)     || 1,
            labSequence:     el('pos-lab-seq').value || '1,2,3'
        };
    }

    // Раньше выбор мартингейла при запущенном боте доходил только до панели: ядро торговало
    // с ММ на момент «Старт».
    function onMMSettingsChange() {
        var mm = collectMMSettings();
        saveSettings(mm);
        if (!window._posRunning) { updateIdleBet(); return; }
        var prevStrategy = mmState.strategy;
        var cfg = Object.assign({}, mm, {
            baseBet: clampBaseBet((document.getElementById('pos-base-bet') || {}).value),
            startBalance: parseFloat((document.getElementById('pos-boost-balance') || {}).value) || 1000
        });
        if (prevStrategy === mm.moneyManagement) {
            // те же правила, другие параметры — текущую серию не сбрасываем
            var keep = { step: mmState.step, currentBet: mmState.currentBet, labSeq: mmState.labSeq };
            mmState.init(cfg);
            Object.assign(mmState, keep);
        } else {
            mmState.init(cfg);
        }
        sendCoreCmd({ cmd: 'PATCH_CONFIG', patch: mm });
        updateIdleBet();
    }

    function updateMMExtra() {
        var val = document.getElementById('pos-mm').value;
        var opt = MM_OPTIONS.find(function(o) { return o.id === val; });
        var extra = document.getElementById('pos-mm-extra');
        document.getElementById('pos-mult-grp').style.display  = 'none';
        document.getElementById('pos-maxsteps-grp').style.display = 'none';
        document.getElementById('pos-steps-grp').style.display = 'none';
        document.getElementById('pos-unit-grp').style.display  = 'none';
        document.getElementById('pos-lab-grp').style.display   = 'none';
        document.getElementById('pos-boost-grp').style.display = 'none';
        if (!opt || !opt.extra) { extra.style.display = 'none'; return; }
        extra.style.display = 'block';
        if (opt.extra === 'mult') {
            document.getElementById('pos-mult-grp').style.display = 'block';
            document.getElementById('pos-mult-lbl').textContent = val === 'anti_mart' ? t('mm_mult_win') : t('mm_mult_lose');
            document.getElementById('pos-maxsteps-grp').style.display = 'block';
        }
        if (opt.extra === 'boost') {
            document.getElementById('pos-boost-grp').style.display  = 'block';
            document.getElementById('pos-mult-grp').style.display   = 'block';
            document.getElementById('pos-mult-lbl').textContent = t('mm_boost_mult');
            document.getElementById('pos-maxsteps-grp').style.display = 'block';
            if (typeof refreshAllBalanceDisplays === 'function') refreshAllBalanceDisplays();
        }
        if (opt.extra === 'steps') document.getElementById('pos-steps-grp').style.display = 'block';
        if (opt.extra === 'unit')  document.getElementById('pos-unit-grp').style.display  = 'block';
        if (opt.extra === 'lab')   document.getElementById('pos-lab-grp').style.display   = 'block';
    }

    // ── SIGNAL CARD ───────────────────────────────────────────────────
    function updateIdleBet() {
        var row = document.getElementById('pos-idle-bet');
        var val = document.getElementById('pos-idle-bet-val');
        if (!row || !val) return;
        var bet = clampBaseBet(mmState.getNextBet());
        val.textContent = '$' + parseFloat(bet).toFixed(2);
        row.style.display = 'block';
    }

    function showSignal(sig) {
        if (currentSignal) return; // ждём ответа по текущему сигналу
        clearSignalTimer();
        sig = Object.assign({}, sig, { amount: clampBaseBet(mmState.getNextBet()) });
        currentSignal = sig;
        var card   = document.getElementById('pos-sig-card');
        var idle   = document.getElementById('pos-sig-idle');
        var active = document.getElementById('pos-sig-active');
        setLiveBoardVisible(false);
        if (!card) return;
        card.className = 'pos-sig-card ' + (sig.direction === 'UP' ? 'up' : 'down');
        idle.style.display   = 'none';
        active.style.display = 'block';
        document.getElementById('pos-sig-arrow').textContent  = sig.direction === 'UP' ? '▲' : '▼';
        document.getElementById('pos-sig-asset').textContent  = sig.asset;
        document.getElementById('pos-sig-label').textContent  = sig.direction === 'UP' ? t('sig_buy') : t('sig_sell');
        document.getElementById('pos-sig-indic').textContent  = sig.indicator;
        var strengthEl = document.getElementById('pos-sig-strength');
        if (strengthEl && sig.matchedCount && sig.totalCount) {
            var dots = '';
            for (var di = 0; di < sig.totalCount; di++) dots += di < sig.matchedCount ? '●' : '○';
            var dotsEl = document.getElementById('pos-sig-dots');
            var strTxt = document.getElementById('pos-sig-strength-txt');
            if (dotsEl) dotsEl.textContent = dots + '  ';
            if (strTxt) strTxt.textContent = sig.matchedCount + '/' + sig.totalCount + t('indicators');
            strengthEl.style.display = 'flex';
        } else if (strengthEl) {
            strengthEl.style.display = 'none';
        }
        playSignalSound();
        document.getElementById('pos-sig-amount').textContent = '$' + parseFloat(sig.amount).toFixed(2);
        var mmInfo = mmState.getStepInfo();
        var mmRow = document.getElementById('pos-sig-mm-row');
        var mmTxt = document.getElementById('pos-sig-mm-txt');
        if (mmRow && mmTxt) {
            if (mmInfo) { mmTxt.textContent = mmInfo; mmRow.style.display = 'flex'; }
            else { mmRow.style.display = 'none'; }
        }
        var timeLeft = getSignalTTL();
        document.getElementById('pos-sig-timer').textContent = timeLeft + 'с';
        signalTimer = setInterval(function() {
            timeLeft--;
            var timerEl = document.getElementById('pos-sig-timer');
            if (timerEl) timerEl.textContent = timeLeft + 'с';
            if (timeLeft <= 0) { awaitResult(); }
        }, 1000);
    }

    function awaitResult() {
        clearSignalTimer();
        // currentSignal остаётся - новый сигнал не появится
        var card = document.getElementById('pos-sig-card');
        if (card) card.className = 'pos-sig-card await';
        var timerEl = document.getElementById('pos-sig-timer');
        if (timerEl) { timerEl.textContent = '⏰'; timerEl.style.color = '#f59e0b'; }
        var hint = document.getElementById('pos-sig-hint');
        if (hint) hint.textContent = t('sig_hint_expired');
    }

    function dismissSignal() {
        clearSignalTimer();
        currentSignal = null;
        var card     = document.getElementById('pos-sig-card');
        var idle     = document.getElementById('pos-sig-idle');
        var active   = document.getElementById('pos-sig-active');
        var strength = document.getElementById('pos-sig-strength');
        if (!card) return;
        card.className = 'pos-sig-card neutral';
        if (idle)     idle.style.display     = 'block';
        if (active)   active.style.display   = 'none';
        if (strength) strength.style.display = 'none';
        if (window._posRunning) setLiveBoardVisible(true);
    }

    function clearSignalTimer() {
        if (signalTimer) { clearInterval(signalTimer); signalTimer = null; }
    }

    var REACT_WIN = ['🤩', '🥳', '🔥', '😍', '😎', '😈'];
    var REACT_LOSE = ['🥲', '🤬', '🥵', '🥶', '😱', '🫨'];

    function showTradeReaction(result) {
        if (!IS_TOP) return;
        if (result !== 'WIN' && result !== 'LOSE') return;
        var set = result === 'WIN' ? REACT_WIN : REACT_LOSE;
        var emoji = set[Math.floor(Math.random() * set.length)];
        var layer = document.getElementById('pos-react-layer');
        if (!layer) {
            layer = document.createElement('div');
            layer.id = 'pos-react-layer';
            layer.className = 'pos-react-layer';
            layer.setAttribute('aria-hidden', 'true');
            (document.body || document.documentElement).appendChild(layer);
        }
        var el = document.createElement('div');
        el.className = 'pos-react-emoji';
        el.textContent = emoji;
        el.style.setProperty('--pos-react-rot', (Math.random() * 28 - 14).toFixed(1) + 'deg');
        layer.appendChild(el);
        setTimeout(function() {
            if (el.parentNode) el.parentNode.removeChild(el);
        }, 1800);
    }

    function netPnlFromResult(result, rawProfit, stake) {
        var bet = parseFloat(stake);
        if (!isFinite(bet) || bet <= 0) bet = 1;
        if (result === 'LOSE') return parseFloat((-bet).toFixed(2));
        if (result !== 'WIN') return 0;
        var p = parseFloat(rawProfit);
        if (!isFinite(p) || p === 0) return parseFloat((bet * 0.85).toFixed(2));
        if (p < 0) return parseFloat(p.toFixed(2));
        if (p > bet * 1.05 && p <= bet * 2.2) return parseFloat((p - bet).toFixed(2));
        if (p > 0 && p <= bet * 1.2) return parseFloat(p.toFixed(2));
        return parseFloat((bet * 0.85).toFixed(2));
    }

    function applySessionPnl(result, pnl) {
        localStats.total++;
        if (result === 'WIN') localStats.wins++;
        else if (result === 'LOSE') localStats.losses++;
        localStats.totalProfit = parseFloat((localStats.totalProfit + pnl).toFixed(2));
        localStats.winRate = localStats.total > 0 ? Math.round(localStats.wins / localStats.total * 100) : 0;
        updateStats(localStats);
    }

    function handleSignalResult(result, exactProfit = null) {
        if (!currentSignal) return;
        var sig = currentSignal;
        dismissSignal();
        if (result !== 'SKIP') {
            mmState.onResult(result);
            updateIdleBet();
            var now = new Date();
            var ts = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0') + ':' + String(now.getSeconds()).padStart(2,'0');
            var profit = (exactProfit !== null && exactProfit !== undefined)
                ? netPnlFromResult(result, exactProfit, sig.amount)
                : netPnlFromResult(result, result === 'WIN' ? sig.amount * 0.85 : -sig.amount, sig.amount);
            applySessionPnl(result, profit);
            updateStreak(result);
            var stratKey = selectedStrategies.slice().sort().join('+') + ' [' + filterMode + ']';
            addTradeToJournal({ time: ts, asset: sig.asset, direction: sig.direction, bet: sig.amount, result: result, profit: profit.toFixed(2), strategy: stratKey });
            posTelemetryTrade(sig, result, profit, stratKey, false);
            var pSign = profit >= 0 ? '+' : '-';
            var tSign = localStats.totalProfit >= 0 ? '+' : '-';
            appendLog((result === 'WIN' ? '✅' : '❌') + ' [' + sig.asset + '] ' + result + ' | P&L: ' + pSign + '$' + Math.abs(profit).toFixed(2) + t('total_suffix') + tSign + '$' + Math.abs(localStats.totalProfit).toFixed(2));
            showTradeReaction(result);
            showBoostTip(localStats.totalProfit);
            checkAutoTradeGuards();
        }
    }

    // ── BUTTONS ───────────────────────────────────────────────────────
    function bindButtons() {
        document.getElementById('pos-start-btn').addEventListener('click', startBot);
        document.getElementById('pos-stop-btn').addEventListener('click', stopBot);
        document.getElementById('pos-boost-apply').addEventListener('click', function() {
            var suggested = mmState.getBoostSuggestion(localStats.totalProfit);
            if (suggested === null) return;
            var el = document.getElementById('pos-base-bet');
            if (el) el.value = suggested.toFixed(2);
            mmState.baseBet    = suggested;
            mmState.betPercent = mmState.startBalance > 0 ? suggested / mmState.startBalance : mmState.betPercent;
            mmState.currentBet = suggested;
            updateIdleBet();
            document.getElementById('pos-boost-tip').style.display = 'none';
            appendLog('💡 Базовая ставка обновлена: $' + suggested.toFixed(2));
        });
        document.getElementById('pos-clear-log').addEventListener('click', function() {
            var log = document.getElementById('pos-log');
            if (log) log.innerHTML = '';
        });
        document.getElementById('pos-copy-log').addEventListener('click', copyLog);
        document.getElementById('pos-sig-win').addEventListener('click',  function() { handleSignalResult('WIN'); });
        document.getElementById('pos-sig-lose').addEventListener('click', function() { handleSignalResult('LOSE'); });
        document.getElementById('pos-sig-skip').addEventListener('click', function() { handleSignalResult('SKIP'); });
        document.getElementById('pos-reset-stats').addEventListener('click', function() {
            if (confirm(t('confirm_reset'))) resetStats();
        });
        document.getElementById('pos-export-csv').addEventListener('click', exportCSV);
        document.getElementById('pos-export-preset').addEventListener('click', exportPreset);
        document.getElementById('pos-import-preset-btn').addEventListener('click', function() {
            document.getElementById('pos-import-preset-file').click();
        });
        document.getElementById('pos-import-preset-file').addEventListener('change', function(e) {
            if (e.target.files[0]) { importPreset(e.target.files[0]); e.target.value = ''; }
        });
        var clearPresetBtn = document.getElementById('pos-clear-preset');
        if (clearPresetBtn) {
            clearPresetBtn.addEventListener('click', clearBuiltinPreset);
        }
        var soundToggleEl = document.getElementById('pos-sound-toggle');
        if (soundToggleEl) {
            soundToggleEl.addEventListener('change', function() {
                soundToggleEl.setAttribute('aria-checked', soundToggleEl.checked ? 'true' : 'false');
            });
        }
        var htfEl = document.getElementById('pos-htf-filter');
        if (htfEl) {
            htfEl.addEventListener('change', function() {
                htfEl.setAttribute('aria-checked', htfEl.checked ? 'true' : 'false');
                saveSettings({ htfFilter: htfEl.checked });
                patchRunningConfig({ htfFilter: htfEl.checked });
            });
        }
        var chartOverlayEl = document.getElementById('pos-chart-ind-sync');
        if (chartOverlayEl) {
            chartOverlayEl.addEventListener('change', function() {
                chartOverlayEl.setAttribute('aria-checked', chartOverlayEl.checked ? 'true' : 'false');
                saveSettings({ chartOverlay: chartOverlayEl.checked });
                syncChartOverlayToCore();
            });
        }
        var streakGuardEl = document.getElementById('pos-streak-guard');
        var streakRow = document.getElementById('pos-streak-guard-row');
        if (streakGuardEl) {
            streakGuardEl.addEventListener('change', function() {
                streakGuardEl.setAttribute('aria-checked', streakGuardEl.checked ? 'true' : 'false');
                if (streakRow) streakRow.style.display = streakGuardEl.checked ? 'grid' : 'none';
                saveSettings({ streakGuard: streakGuardEl.checked });
            });
        }
        ['pos-streak-limit', 'pos-streak-pause'].forEach(function(id) {
            var el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', function() {
                saveSettings({
                    streakLimit: parseInt(document.getElementById('pos-streak-limit').value, 10) || 3,
                    streakPauseMin: parseFloat(document.getElementById('pos-streak-pause').value) || 10
                });
            });
        });
        var expSel = document.getElementById('pos-expiration');
        if (expSel) {
            function onExpirationChange() {
                signalExpirationSec = normalizeExpiration(expSel.value);
                saveSettings({ expiration: signalExpirationSec });
                sendCoreCmd({ cmd: 'PATCH_CONFIG', patch: { expiration: signalExpirationSec } });
                refreshLiveBoard();
            }
            expSel.addEventListener('change', onExpirationChange);
            expSel.addEventListener('input', onExpirationChange);
        }
        var baseBetEl = document.getElementById('pos-base-bet');
        if (baseBetEl) {
            function onBaseBetChange() {
                var bet = clampBaseBet(baseBetEl.value);
                if (parseFloat(baseBetEl.value) !== bet) baseBetEl.value = bet;
                saveSettings({ baseBet: bet });
                sendCoreCmd({ cmd: 'PATCH_CONFIG', patch: { baseBet: bet } });
                updateIdleBet();
            }
            baseBetEl.addEventListener('change', onBaseBetChange);
            baseBetEl.addEventListener('input', onBaseBetChange);
        }
        var autoEl = document.getElementById('pos-auto-trade');
        if (autoEl) {
            var syncAutoAria = function() {
                autoEl.setAttribute('aria-checked', autoEl.checked ? 'true' : 'false');
            };
            syncAutoAria();
            autoEl.addEventListener('change', function() {
                syncAutoAria();
                var realConfirmedNow = false;
                if (autoEl.checked && window._poAccountType === 'real') {
                    if (!window.confirm('Включить мульти-парную автоторговлю на REAL-счёте? Возможны несколько одновременных сделок.')) {
                        autoEl.checked = false;
                        syncAutoAria();
                    } else {
                        realConfirmedNow = true;
                    }
                }
                if (autoEl.checked) beginAutoTradeSession();
                else window._poRiskStartBalance = null;
                var autoPatch = collectRiskSettings({ autoTrade: autoEl.checked });
                saveSettings(autoPatch);
                if (window._posRunning) {
                    if (realConfirmedNow) autoPatch.realTradeConfirmed = true;
                    sendCoreCmd({ cmd: 'PATCH_CONFIG', patch: autoPatch });
                }
                checkAutoTradeGuards();
            });
        }
        var riskEnableEl = document.getElementById('pos-risk-enable');
        var riskWrap = document.getElementById('pos-risk-wrap');
        if (riskEnableEl) {
            riskEnableEl.addEventListener('change', function() {
                riskEnableEl.setAttribute('aria-checked', riskEnableEl.checked ? 'true' : 'false');
                if (riskWrap) riskWrap.style.display = riskEnableEl.checked ? 'block' : 'none';
                saveSettings(collectRiskSettings());
                if (window._posRunning) sendCoreCmd({ cmd: 'PATCH_CONFIG', patch: collectRiskSettings() });
            });
        }
        ['pos-tp-val', 'pos-tl-val'].forEach(function(id) {
            var el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', onRiskSettingChange);
            el.addEventListener('input', onRiskSettingChange);
        });
        bindRiskSegment('pos-tp-seg', 'pos-tp-mode', 'pos-tp-unit');
        bindRiskSegment('pos-tl-seg', 'pos-tl-mode', 'pos-tl-unit');
        syncRiskSegmentUI();
    }

    function bindRiskSegment(segId, modeId, unitId) {
        var seg = document.getElementById(segId);
        var modeEl = document.getElementById(modeId);
        if (!seg || !modeEl) return;
        seg.querySelectorAll('.pos-risk-seg-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                var val = btn.getAttribute('data-value') || 'percent';
                modeEl.value = val;
                seg.querySelectorAll('.pos-risk-seg-btn').forEach(function(b) {
                    b.classList.toggle('active', b.getAttribute('data-value') === val);
                });
                var unit = document.getElementById(unitId);
                if (unit) unit.textContent = val === 'amount' ? '$' : '%';
                onRiskSettingChange();
            });
        });
    }

    function syncRiskSegmentUI() {
        [
            { seg: 'pos-tp-seg', mode: 'pos-tp-mode', unit: 'pos-tp-unit' },
            { seg: 'pos-tl-seg', mode: 'pos-tl-mode', unit: 'pos-tl-unit' }
        ].forEach(function(cfg) {
            var modeEl = document.getElementById(cfg.mode);
            var seg = document.getElementById(cfg.seg);
            var unit = document.getElementById(cfg.unit);
            if (!modeEl || !seg) return;
            var val = modeEl.value === 'amount' ? 'amount' : 'percent';
            modeEl.value = val;
            seg.querySelectorAll('.pos-risk-seg-btn').forEach(function(b) {
                b.classList.toggle('active', b.getAttribute('data-value') === val);
            });
            if (unit) unit.textContent = val === 'amount' ? '$' : '%';
        });
    }

    function collectRiskSettings(extra) {
        var out = {
            riskEnabled: !!(document.getElementById('pos-risk-enable') || {}).checked,
            riskTpMode: (document.getElementById('pos-tp-mode') || {}).value || 'percent',
            riskTpValue: parseFloat((document.getElementById('pos-tp-val') || {}).value) || 0,
            riskTlMode: (document.getElementById('pos-tl-mode') || {}).value || 'percent',
            riskTlValue: parseFloat((document.getElementById('pos-tl-val') || {}).value) || 0
        };
        if (extra) Object.assign(out, extra);
        return out;
    }

    function onRiskSettingChange() {
        saveSettings(collectRiskSettings({
            autoTrade: !!(document.getElementById('pos-auto-trade') || {}).checked
        }));
        if (window._posRunning) {
            sendCoreCmd({ cmd: 'PATCH_CONFIG', patch: collectRiskSettings({
                autoTrade: !!(document.getElementById('pos-auto-trade') || {}).checked
            }) });
        }
        checkAutoTradeGuards();
    }

    function beginAutoTradeSession() {
        var bal = getAvailableBalance();
        window._poRiskStartBalance = (bal != null && bal > 0) ? bal : null;
    }

    var _toastTimer = null;
    function showToast(message, kind) {
        var el = document.getElementById('pos-toast');
        if (!el) return;
        el.textContent = message;
        el.className = 'pos-toast show' + (kind ? ' is-' + kind : ' is-err');
        el.hidden = false;
        if (_toastTimer) clearTimeout(_toastTimer);
        _toastTimer = setTimeout(function() {
            el.classList.remove('show');
            setTimeout(function() { el.hidden = true; }, 280);
        }, 4500);
        try {
            if (document.getElementById('pos-sound-toggle')?.checked) {
                // короткий звук через Web Audio если доступен
                var Ctx = window.AudioContext || window.webkitAudioContext;
                if (Ctx) {
                    var ctx = new Ctx();
                    var o = ctx.createOscillator();
                    var g = ctx.createGain();
                    o.type = 'sine';
                    o.frequency.value = kind === 'ok' ? 880 : 320;
                    g.gain.value = 0.04;
                    o.connect(g); g.connect(ctx.destination);
                    o.start();
                    setTimeout(function() { try { o.stop(); ctx.close(); } catch(_) {} }, 180);
                }
            }
        } catch(_) {}
    }

    function setAutoTradeEnabled(on, opts) {
        opts = opts || {};
        var autoEl = document.getElementById('pos-auto-trade');
        if (!autoEl) return;
        var next = !!on;
        if (autoEl.checked === next && !opts.force) return;
        autoEl.checked = next;
        autoEl.setAttribute('aria-checked', next ? 'true' : 'false');
        if (next) beginAutoTradeSession();
        else window._poRiskStartBalance = null;
        saveSettings(collectRiskSettings({ autoTrade: next }));
        if (window._posRunning) {
            sendCoreCmd({ cmd: 'PATCH_CONFIG', patch: collectRiskSettings({ autoTrade: next }) });
        }
    }

    function disableAutoTrade(reasonKey, kind) {
        var autoEl = document.getElementById('pos-auto-trade');
        if (!autoEl || !autoEl.checked) return;
        setAutoTradeEnabled(false);
        var msg = t(reasonKey) || reasonKey;
        showToast(msg, kind || 'err');
        appendLog('⛔ ' + msg);
    }

    function resolveRiskThreshold(mode, value, startBal) {
        var v = parseFloat(value);
        if (!v || v <= 0) return null;
        if (mode === 'amount') return v;
        if (startBal == null || startBal <= 0) return null;
        return parseFloat((startBal * (v / 100)).toFixed(2));
    }

    function getNextAutoBetAmount() {
        try {
            if (typeof mmState !== 'undefined' && mmState.getNextBet) {
                return clampBaseBet(mmState.getNextBet());
            }
        } catch(_) {}
        return clampBaseBet((document.getElementById('pos-base-bet') || {}).value || 1);
    }

    function checkAutoTradeGuards() {
        var autoEl = document.getElementById('pos-auto-trade');
        if (!autoEl || !autoEl.checked) return;

        var bal = getAvailableBalance();
        var nextBet = getNextAutoBetAmount();
        // Недостаточно денег на следующую ставку
        if (bal != null && nextBet != null && bal + 1e-9 < nextBet) {
            disableAutoTrade('toast_low_balance', 'err');
            return;
        }
        // Минимальный порог платформы ~$1, если баланс меньше минимума
        if (bal != null && bal < 1 && nextBet >= 1) {
            disableAutoTrade('toast_low_balance', 'err');
            return;
        }

        var riskEnableEl = document.getElementById('pos-risk-enable');
        if (!riskEnableEl || !riskEnableEl.checked) return;

        var startBal = window._poRiskStartBalance;
        if (startBal == null && bal != null) {
            window._poRiskStartBalance = bal;
            startBal = bal;
        }
        if (startBal == null || bal == null) return;

        var delta = parseFloat((bal - startBal).toFixed(2));
        var tpLimit = resolveRiskThreshold(
            (document.getElementById('pos-tp-mode') || {}).value || 'percent',
            (document.getElementById('pos-tp-val') || {}).value,
            startBal
        );
        var tlLimit = resolveRiskThreshold(
            (document.getElementById('pos-tl-mode') || {}).value || 'percent',
            (document.getElementById('pos-tl-val') || {}).value,
            startBal
        );

        if (tpLimit != null && delta >= tpLimit) {
            disableAutoTrade('toast_take_profit', 'ok');
            return;
        }
        if (tlLimit != null && delta <= -tlLimit) {
            disableAutoTrade('toast_take_loss', 'err');
        }
    }

    function startBot() {
        var realTradeConfirmed = false;
        var config = {
            indicators:      selectedStrategies.slice(),
            indicator:       selectedStrategies[0] || 'RSI',
            filterMode:      filterMode,
            confirmMode:     confirmMode,
            triggerPolicy:   triggerPolicy || undefined,
            moneyManagement: document.getElementById('pos-mm').value,
            baseBet:         clampBaseBet(document.getElementById('pos-base-bet').value),
            multiplier:      parseFloat(document.getElementById('pos-mult').value)     || 2,
            parlaySteps:     parseInt(document.getElementById('pos-steps').value)      || 2,
            dalembertUnit:   parseFloat(document.getElementById('pos-unit').value)     || 1,
            labSequence:     document.getElementById('pos-lab-seq').value || '1,2,3',
            startBalance:    parseFloat(document.getElementById('pos-boost-balance').value) || 1000,
            expiration:      normalizeExpiration(document.getElementById('pos-expiration').value),
            autoTrade:       !!document.getElementById('pos-auto-trade')?.checked,
            htfFilter:       !!document.getElementById('pos-htf-filter')?.checked,
            chartOverlay:    !!document.getElementById('pos-chart-ind-sync')?.checked,
            selectedPairs:   [],
            multiPairTrading: !!document.getElementById('pos-multi-pair')?.checked,
            minProfit:       parseFloat(document.getElementById('pos-min-profit')?.value || '92'),
            maxConcurrentTrades: parseInt(document.getElementById('pos-max-concurrent')?.value || '4', 10),
            includeOtc:      !!document.getElementById('pos-include-otc')?.checked,
            reverseEnabled:  !!document.getElementById('pos-reverse-enabled')?.checked,
            reverseWins:     parseInt(document.getElementById('pos-reverse-wins')?.value || '3', 10)
        };
        if (config.autoTrade && window._poAccountType === 'real') {
            if (window.confirm('Вы включаете автоторговлю на REAL-счёте. Сделки по нескольким валютным парам могут открываться почти одновременно. Продолжить?')) {
                realTradeConfirmed = true;
            } else {
                config.autoTrade = false;
                var autoToggle = document.getElementById('pos-auto-trade');
                if (autoToggle) autoToggle.checked = false;
            }
        }
        Object.assign(config, collectRiskSettings());
        if (config.autoTrade) beginAutoTradeSession();
        signalExpirationSec = config.expiration;
        config.maxSteps = parseInt(document.getElementById('pos-max-steps').value) || 5;
        var cfgInd = {};
        document.querySelectorAll('.pos-ind-input').forEach(function(inp) {
            var ind = inp.dataset.ind, key = inp.dataset.key;
            if (!cfgInd[ind]) cfgInd[ind] = {};
            cfgInd[ind][key] = parseFloat(inp.value) || 0;
        });
        config.indConfig = Object.keys(cfgInd).length ? cfgInd : indConfig;
        // Use real balance from platform as startBalance if available
        if (window._poActiveBalance != null && window._poActiveBalance > 0) {
            config.startBalance = window._poActiveBalance;
        } else if (window._poRealBalance != null && window._poRealBalance > 0) {
            config.startBalance = window._poRealBalance;
        }
        mmState.init(config);
        updateIdleBet();
        saveSettings(config);
        if (realTradeConfirmed) config.realTradeConfirmed = true;
        window._posRunning = true;
        posTelemetryState();
        setRunning(true);
        setLiveBoardVisible(true);
        updateLiveScan(buildLiveScanStub());
        var log = document.getElementById('pos-log');
        if (log) log.innerHTML = '';
        // Direct dispatch to inject.js (MAIN world) - primary signal path
        try { sendCoreCmd({ cmd: 'START', config: config }); } catch(_) {}
    }

    function stopBot() {
        window._posRunning = false;
        posTelemetryState();
        setRunning(false);
        setLiveBoardVisible(false);
        dismissSignal();
        try { sendCoreCmd({ cmd: 'STOP' }); } catch(_) {}
    }

    function setRunning(on) {
        var pill = document.getElementById('pos-pill');
        if (pill) {
            pill.classList.toggle('run', on);
            pill.title = on ? t('pill_run') : t('pill_stop');
        }
        var s = document.getElementById('pos-start-btn');
        var stopBtn = document.getElementById('pos-stop-btn');
        if (s) s.classList.toggle('hidden', on);
        if (stopBtn) stopBtn.classList.toggle('hidden', !on);
        var startHint = document.getElementById('pos-idle-start-hint');
        if (startHint) startHint.style.display = on ? 'none' : '';
        var waitTxt = document.querySelector('#pos-sig-idle .pos-sig-idle-txt');
        if (waitTxt) waitTxt.style.display = on ? '' : '';
    }

    // ── LOG ───────────────────────────────────────────────────────────
    function appendLog(message) {
        var log = document.getElementById('pos-log');
        if (!log) return;
        var line = document.createElement('div');
        var m = message || '';
        var cls = 'pos-ll';
        if (m.indexOf('✅') >= 0 || m.indexOf('WIN') >= 0)           cls += ' win';
        else if (m.indexOf('❌') >= 0 || m.indexOf('LOSE') >= 0)     cls += ' lose';
        else if (m.indexOf('📡') >= 0 || m.indexOf('🤖') >= 0 ||
                 m.indexOf('🛑') >= 0 || m.indexOf('🎯') >= 0)       cls += ' info';
        else if (m.indexOf('⚠️') >= 0)                               cls += ' warn';
        line.className = cls;
        var now = new Date();
        var ts = '[' + String(now.getHours()).padStart(2,'0') + ':' +
                       String(now.getMinutes()).padStart(2,'0') + ':' +
                       String(now.getSeconds()).padStart(2,'0') + ']';
        line.textContent = /^\[\d{1,2}:\d{2}:\d{2}\]/.test(m) ? m : (ts + ' ' + m);
        log.appendChild(line);
        log.scrollTop = log.scrollHeight;
        while (log.children.length > 80) log.removeChild(log.firstChild);
    }

    function copyLog() {
        var log = document.getElementById('pos-log');
        var btn = document.getElementById('pos-copy-log');
        if (!log || !log.children.length) {
            if (btn) {
                var emptyOrig = btn.textContent;
                btn.textContent = '-';
                setTimeout(function() { btn.textContent = emptyOrig; }, 1200);
            }
            return;
        }
        var text = Array.prototype.map.call(log.children, function(el) { return el.textContent; }).join('\n');
        function onCopied() {
            if (!btn) return;
            var orig = btn.textContent;
            btn.textContent = t('log_copied');
            setTimeout(function() { btn.textContent = orig; }, 1500);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(onCopied).catch(function() {
                fallbackCopy(text) && onCopied();
            });
        } else {
            fallbackCopy(text) && onCopied();
        }
    }

    function fallbackCopy(text) {
        try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            var ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
        } catch (_) {
            return false;
        }
    }

    // ── IND PARAMS ──────────────────────────────────────────────────────
    function renderIndParams() {
        var sec  = document.getElementById('pos-ind-params-section');
        var grid = document.getElementById('pos-ind-params-grid');
        if (!sec || !grid) return;
        var visible = selectedStrategies.filter(function(id) {
            return IND_PARAMS_META[id] && IND_PARAMS_META[id].length > 0;
        });
        if (visible.length === 0) { sec.style.display = 'none'; return; }
        sec.style.display = 'block';
        grid.innerHTML = '';
        visible.forEach(function(id) {
            var meta  = IND_PARAMS_META[id];
            var strat = STRATEGIES.find(function(s) { return s.id === id; });
            var block = document.createElement('div');
            block.className = 'pos-ind-cfg';
            var nameDiv = document.createElement('div');
            nameDiv.className = 'pos-ind-cfg-name';
            nameDiv.textContent = strat ? strat.icon + ' ' + strat.name : id;
            block.appendChild(nameDiv);
            var row = document.createElement('div');
            row.className = 'pos-frow';
            meta.forEach(function(p) {
                var cur = (indConfig[id] && indConfig[id][p.key] != null) ? indConfig[id][p.key] : p.def;
                var fg = document.createElement('div');
                fg.className = 'pos-fg';
                var lbl = document.createElement('label'); lbl.textContent = p.label;
                var inp = document.createElement('input');
                inp.type = 'number'; inp.className = 'pos-ind-input';
                inp.dataset.ind = id; inp.dataset.key = p.key;
                inp.value = cur; inp.min = p.min; inp.max = p.max; inp.step = p.step;
                fg.appendChild(lbl); fg.appendChild(inp);
                row.appendChild(fg);
            });
            block.appendChild(row);
            grid.appendChild(block);
        });
        grid.querySelectorAll('.pos-ind-input').forEach(function(inp) {
            inp.addEventListener('change', function() {
                if (!indConfig[inp.dataset.ind]) indConfig[inp.dataset.ind] = {};
                indConfig[inp.dataset.ind][inp.dataset.key] = parseFloat(inp.value) || 0;
                saveSettings();
                if (window._posRunning) {
                    patchRunningConfig({ indConfig: JSON.parse(JSON.stringify(indConfig)) });
                    refreshLiveBoard();
                }
            });
        });
    }

    // ── SOUND ─────────────────────────────────────────────────────────
    function playSignalSound() {
        try {
            var toggle = document.getElementById('pos-sound-toggle');
            if (toggle && !toggle.checked) return;
            var ctx = new (window.AudioContext || window.webkitAudioContext)();
            var osc  = ctx.createOscillator();
            var gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.setValueAtTime(880,  ctx.currentTime);
            osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
            gain.gain.setValueAtTime(0.3, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.45);
        } catch(_) {}
    }

    // ── STREAK ────────────────────────────────────────────────────────
    function updateStreak(result) {
        if (result !== 'WIN' && result !== 'LOSE') return;
        if (result === currentStreak.type) { currentStreak.count++; }
        else { currentStreak.type = result; currentStreak.count = 1; }
        renderStreak();
        checkLossStreakGuard();
    }

    function checkLossStreakGuard() {
        var guardEl = document.getElementById('pos-streak-guard');
        if (!guardEl || !guardEl.checked) return;
        if (currentStreak.type !== 'LOSE') return;
        var limit = parseInt((document.getElementById('pos-streak-limit') || {}).value, 10) || 3;
        if (currentStreak.count < limit) return;

        var autoEl = document.getElementById('pos-auto-trade');
        var wasAuto = !!(autoEl && autoEl.checked);
        var msg = t('toast_loss_streak');
        appendLog('⏸ ' + msg + ' (' + currentStreak.count + ')');
        if (!wasAuto) return; // сигналы можно продолжать вести вручную

        setAutoTradeEnabled(false, { force: true });
        showToast(msg, 'err');

        var pauseMin = parseFloat((document.getElementById('pos-streak-pause') || {}).value) || 10;
        if (_lossStreakTimer) clearTimeout(_lossStreakTimer);
        _lossStreakTimer = setTimeout(function() {
            _lossStreakTimer = null;
            currentStreak.type = null;
            currentStreak.count = 0;
            renderStreak();
            var guardStillOn = document.getElementById('pos-streak-guard');
            if (wasAuto && guardStillOn && guardStillOn.checked) {
                setAutoTradeEnabled(true, { force: true });
                appendLog(t('toast_loss_streak_resume'));
            }
        }, pauseMin * 60000);
    }

    function renderStreak() {
        var row = document.getElementById('pos-streak-row');
        if (!row) return;
        if (!currentStreak.type || currentStreak.count < 2) { row.style.display = 'none'; return; }
        var iconEl = document.getElementById('pos-streak-icon');
        var txtEl  = document.getElementById('pos-streak-txt');
        if (iconEl) iconEl.textContent = currentStreak.type === 'WIN' ? '🔥' : '❄️';
        if (txtEl)  txtEl.textContent  = currentStreak.count + (currentStreak.type === 'WIN' ? t('streak_wins') : t('streak_losses'));
        row.style.display = 'flex';
    }

    // ── CSV EXPORT ────────────────────────────────────────────────────
    function exportCSV() {
        if (journal.length === 0) { alert(t('csv_empty')); return; }
        var now = new Date();
        var y = now.getFullYear();
        var m = String(now.getMonth() + 1).padStart(2, '0');
        var d = String(now.getDate()).padStart(2, '0');
        var dateStr = y + '-' + m + '-' + d;
        var timeStr = now.toLocaleTimeString(currentLang === 'en' ? 'en-GB' : 'ru-RU', { hour: '2-digit', minute: '2-digit' });

        var header = [
            '══════════════════════════════════════════════',
            '  ' + BRAND_NAME,
            '  https://' + BRAND_SITE,
            '  ' + (currentLang === 'en' ? 'Statistics export' : 'Экспорт статистики') + ': ' + dateStr + '  ' + timeStr,
            '══════════════════════════════════════════════',
            ''
        ];

        var rows = [t('csv_headers').slice()];
        journal.forEach(function(tr) {
            rows.push([tr.time, tr.asset, tr.direction,
                parseFloat(tr.bet).toFixed(2), tr.result, parseFloat(tr.profit).toFixed(2)]);
        });
        var body = rows.map(function(r) { return r.join(';'); }).join('\n');
        var csv = header.join('\n') + '\n' + body;
        var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = dateStr + '-pocketoption-stat.csv';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        appendLog(t('csv_exported'));
    }

    // ── STATS ─────────────────────────────────────────────────────────
    function syncStatsFromExternal(stats) {
        // Сессия считается только по зафиксированным сделкам (handleSignalResult /
        // autoRecordResult). Статистика мани-менеджера сюда не подмешиваем -
        // иначе один и тот же результат плюсуется дважды.
        if (!stats) return;
    }

    function updateStats(stats) {
        if (!stats) return;
        var profit = parseFloat(stats.totalProfit || 0);
        var set = function(id, val) { var e = document.getElementById(id); if (e) e.textContent = val; };
        var pEl = document.getElementById('pos-profit-val');
        if (pEl) {
            pEl.textContent = (profit >= 0 ? '+' : '-') + '$' + Math.abs(profit).toFixed(2);
            pEl.className = profit > 0 ? 'g' : profit < 0 ? 'r' : '';
        }
        set('bs-total',  stats.total   || 0);
        set('bs-wins',   stats.wins    || 0);
        set('bs-losses', stats.losses  || 0);
        set('bs-wr',     (stats.winRate || 0) + '%');
        set('qj-total',  stats.total   || 0);
        set('qj-wins',   stats.wins    || 0);
        set('qj-losses', stats.losses  || 0);
        var bjPEl = document.getElementById('qj-profit');
        if (bjPEl) {
            bjPEl.textContent = (profit >= 0 ? '+' : '-') + '$' + Math.abs(profit).toFixed(2);
            bjPEl.className = 'pos-sv ' + (profit > 0 ? 'g' : profit < 0 ? 'r' : 'c');
        }
    }

    // ── TELEMETRY ─────────────────────────────────────────────────────
    // Состояние вкладки и сделки уходят в background (bridge/bridge-client.js); на сервер они
    // отправляются только при активной лицензии Windows-приложения. ARCHITECTURE.md §11.
    var _posTelemAsset = '';
    function posTelemetry(kind, data) {
        try {
            var api = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;
            var p = api.runtime.sendMessage(Object.assign({ type: 'POS_TELEMETRY', kind: kind }, data));
            if (p && typeof p.catch === 'function') p.catch(function() {});
        } catch (_) {}
    }
    /** Снимок параметров стратегии для админки (ARCHITECTURE.md §11.2): что выбрано в панели сейчас. */
    function posStrategySnapshot() {
        try {
            var el = function(id) { return document.getElementById(id) || {}; };
            var num = function(id, def) { var v = parseFloat(el(id).value); return isFinite(v) ? v : def; };
            var inds = selectedStrategies.slice().sort();
            var ic = {};
            inds.forEach(function(id) { if (indConfig[id]) ic[id] = Object.assign({}, indConfig[id]); });
            var mm = el('pos-mm').value || 'fixed';
            var cfg = {
                v: 1,
                preset: activeBuiltinPresetId || '',
                indicators: inds,
                filterMode: filterMode,
                confirmMode: confirmMode,
                triggerPolicy: triggerPolicy || '',
                expiration: signalExpirationSec,
                htfFilter: !!el('pos-htf-filter').checked,
                autoTrade: !!el('pos-auto-trade').checked,
                mm: mm,
                baseBet: num('pos-base-bet', 1),
                indConfig: ic
            };
            var mmOpt = MM_OPTIONS.find(function(o) { return o.id === mm; });
            var extra = mmOpt ? mmOpt.extra : null;
            if (extra === 'mult' || extra === 'boost') { cfg.multiplier = num('pos-mult', 2); cfg.maxSteps = num('pos-max-steps', 5); }
            if (extra === 'boost') cfg.startBalance = num('pos-boost-balance', 1000);
            else if (extra === 'steps') cfg.parlaySteps = num('pos-steps', 2);
            else if (extra === 'unit') cfg.dalembertUnit = num('pos-unit', 1);
            else if (extra === 'lab') cfg.labSequence = String(el('pos-lab-seq').value || '').slice(0, 60);
            var r = collectRiskSettings();
            cfg.risk = r.riskEnabled ? { tp: r.riskTpValue, tpMode: r.riskTpMode, tl: r.riskTlValue, tlMode: r.riskTlMode } : null;
            return cfg;
        } catch (_) { return null; }
    }
    /** Балансы счетов PO для админки: число или null, если ещё не прочитан. */
    function posBalanceSnapshot() {
        var num = function(v) { v = parseFloat(v); return isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null; };
        var demo = num(window._poDemoBalance), real = num(window._poRealBalance);
        if (demo == null && real == null) return null;
        return { demo: demo, real: real };
    }
    function posTelemetryState() {
        if (!IS_TOP || (!_posTelemAsset && !window._posRunning)) return; // не торговый терминал
        posTelemetry('state', { state: { asset: _posTelemAsset, acct: window._poAccountType || '', bot: !!window._posRunning, bal: posBalanceSnapshot(), cfg: posStrategySnapshot() } });
    }
    function posTelemetryTrade(sig, result, profit, strategy, auto) {
        posTelemetry('trade', { trade: {
            id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
            t: Math.floor(Date.now() / 1000),
            asset: sig.asset || _posTelemAsset,
            dir: String(sig.direction || '').toLowerCase(),
            amount: parseFloat(sig.amount) || 0,
            profit: parseFloat(profit) || 0,
            result: result,
            acct: window._poAccountType || '',
            auto: !!auto,
            strategy: strategy,
            cfg: posStrategySnapshot()
        } });
    }
    if (IS_TOP) setInterval(posTelemetryState, 30000);

    // ── JOURNAL ───────────────────────────────────────────────────────
    function addTradeToJournal(trade) {
        journal.unshift(trade);
        if (journal.length > 200) journal.pop();
        renderJournal();
    }

    function resetStats() {
        localStats.total = 0; localStats.wins = 0; localStats.losses = 0;
        localStats.totalProfit = 0; localStats.winRate = 0;
        journal.length = 0;
        currentStreak.type = null; currentStreak.count = 0;
        if (_lossStreakTimer) { clearTimeout(_lossStreakTimer); _lossStreakTimer = null; }
        updateStats(localStats);
        renderJournal();
        renderStreak();
        renderAssetStats();
        renderIndStats();
        appendLog(t('stats_reset'));
    }

    // ── SAFE HTML HELPER (avoids innerHTML linter warnings) ──────────
    function posSetHTML(el, html) {
        var doc = (new DOMParser()).parseFromString('<body>' + html + '</body>', 'text/html');
        while (el.firstChild) el.removeChild(el.firstChild);
        Array.prototype.slice.call(doc.body.childNodes).forEach(function(n) {
            el.appendChild(document.importNode(n, true));
        });
    }

    // ── ASSET / INDICATOR STATISTICS ─────────────────────────────────
    function renderAssetStats() {
        var wrap = document.getElementById('pos-asset-stats-wrap');
        if (!wrap) return;
        if (journal.length === 0) {
            posSetHTML(wrap, '<div class="qj-none">' + t('stats_no_data') + '</div>');
            return;
        }
        var map = {};
        journal.forEach(function(tr) {
            var a = tr.asset || '?';
            if (!map[a]) map[a] = { trades: 0, wins: 0, losses: 0, profit: 0 };
            map[a].trades++;
            if (tr.result === 'WIN') map[a].wins++; else map[a].losses++;
            map[a].profit = parseFloat((map[a].profit + parseFloat(tr.profit || 0)).toFixed(2));
        });
        var sorted = Object.keys(map).sort(function(a, b) { return map[b].trades - map[a].trades; });
        var rows = sorted.map(function(a) {
            var s = map[a]; var wr = Math.round(s.wins / s.trades * 100); var pl = s.profit;
            return '<tr><td style="font-size:10px">' + a + '</td><td>' + s.trades + '</td><td class="g">' + s.wins + '</td><td class="r">' + s.losses + '</td><td class="' + (wr >= 50 ? 'g' : 'r') + '">' + wr + '%</td><td class="' + (pl >= 0 ? 'g' : 'r') + '">' + (pl >= 0 ? '+' : '') + '$' + Math.abs(pl).toFixed(2) + '</td></tr>';
        }).join('');
        posSetHTML(wrap, '<table class="qj-table"><thead><tr><th>' + t('jrn_asset') + '</th><th>N</th><th>W</th><th>L</th><th>WR</th><th>P&L</th></tr></thead><tbody>' + rows + '</tbody></table>');
    }

    function renderIndStats() {
        var wrap = document.getElementById('pos-ind-stats-wrap');
        if (!wrap) return;
        var filtered = journal.filter(function(tr) { return tr.strategy; });
        if (filtered.length === 0) {
            posSetHTML(wrap, '<div class="qj-none">' + t('stats_no_data') + '</div>');
            return;
        }
        var map = {};
        filtered.forEach(function(tr) {
            var k = tr.strategy;
            if (!map[k]) map[k] = { trades: 0, wins: 0, losses: 0, profit: 0 };
            map[k].trades++;
            if (tr.result === 'WIN') map[k].wins++; else map[k].losses++;
            map[k].profit = parseFloat((map[k].profit + parseFloat(tr.profit || 0)).toFixed(2));
        });
        var sorted = Object.keys(map).sort(function(a, b) { return map[b].trades - map[a].trades; });
        var rows = sorted.map(function(k) {
            var s = map[k]; var wr = Math.round(s.wins / s.trades * 100); var pl = s.profit;
            return '<tr><td style="font-size:9px;max-width:70px;word-break:break-all">' + k + '</td><td>' + s.trades + '</td><td class="g">' + s.wins + '</td><td class="r">' + s.losses + '</td><td class="' + (wr >= 50 ? 'g' : 'r') + '">' + wr + '%</td><td class="' + (pl >= 0 ? 'g' : 'r') + '">' + (pl >= 0 ? '+' : '') + '$' + Math.abs(pl).toFixed(2) + '</td></tr>';
        }).join('');
        posSetHTML(wrap, '<table class="qj-table"><thead><tr><th style="font-size:9px">' + t('stat_strat') + '</th><th>N</th><th>W</th><th>L</th><th>WR</th><th>P&L</th></tr></thead><tbody>' + rows + '</tbody></table>');
    }

    // ── PRESET LIBRARY / EXPORT / IMPORT ──────────────────────────────
    function getPresetTabMeta(exp) {
        return PRESET_EXP_TABS.find(function(t) { return t.exp === exp; }) || PRESET_EXP_TABS[0];
    }

    function presetSource() { return BUILTIN_PRESETS; }

    function presetTabsList() { return PRESET_EXP_TABS; }

    function presetsForExp(exp) {
        return BUILTIN_PRESETS.filter(function(p) { return p.expiration === exp; });
    }

    function syncPresetTabFromActive() {
        if (!activeBuiltinPresetId) return;
        var p = BUILTIN_PRESETS.find(function(x) { return x.id === activeBuiltinPresetId; });
        if (p && p.expiration) activePresetExpTab = p.expiration;
    }

    function snapPresetExpTab(exp) {
        exp = parseInt(exp, 10) || 15;
        if (LEGACY_EXPIRATIONS[exp]) exp = LEGACY_EXPIRATIONS[exp];
        var tabsList = presetTabsList();
        if (!tabsList.length) return exp;
        if (tabsList.some(function(t) { return t.exp === exp; })) return exp;
        var best = tabsList[0].exp;
        var bestDiff = Math.abs(best - exp);
        tabsList.forEach(function(t) {
            var d = Math.abs(t.exp - exp);
            if (d < bestDiff) { bestDiff = d; best = t.exp; }
        });
        return best;
    }

    function updatePresetTabHint() {
        var hint = document.getElementById('pos-preset-hint');
        if (!hint) return;
        var meta = presetTabsList().find(function(x) { return x.exp === activePresetExpTab; }) || getPresetTabMeta(activePresetExpTab);
        var base = t('preset_hint');
        var tabHint = currentLang === 'en' ? (meta.en_hint || meta.hint) : meta.hint;
        hint.textContent = base + (tabHint ? ' ' + tabHint : '');
    }

    function buildPresetGrid() {
        var tabs = document.getElementById('pos-preset-tabs');
        var grid = document.getElementById('pos-preset-grid');
        if (!tabs || !grid) return;

        activePresetExpTab = snapPresetExpTab(activePresetExpTab);

        tabs.innerHTML = '';
        presetTabsList().forEach(function(tab) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'pos-preset-tab' + (activePresetExpTab === tab.exp ? ' active' : '');
            btn.dataset.exp = String(tab.exp);
            btn.setAttribute('role', 'tab');
            btn.setAttribute('aria-selected', activePresetExpTab === tab.exp ? 'true' : 'false');
            btn.textContent = currentLang === 'en' ? tab.en_label : tab.label;
            btn.addEventListener('click', function() {
                activePresetExpTab = tab.exp;
                buildPresetGrid();
            });
            tabs.appendChild(btn);
        });

        grid.innerHTML = '';
        presetsForExp(activePresetExpTab).forEach(function(p) {
            var card = document.createElement('button');
            card.type = 'button';
            var mark = p.id;
            card.className = 'pos-preset-card tone-' + (p.tone || 'scalp') +
                (activeBuiltinPresetId === mark ? ' active' : '');
            card.dataset.presetId = p.id;
            card.innerHTML =
                '<span class="pos-preset-card-top">' +
                    '<span class="pos-preset-name"></span>' +
                    '<span class="pos-preset-tag">' + (p.tag || '') + '</span>' +
                '</span>' +
                '<span class="pos-preset-desc"></span>' +
                '<span class="pos-preset-meta">' +
                    (p.selectedStrategies || []).join(' · ') +
                    ' · ' + (p.filterMode || 'ALL') +
                    (p.confirmMode && p.confirmMode !== 'auto' ? ' · ' + p.confirmMode : '') +
                    (p.htfFilter ? ' · HTF' : '') +
                    (p.suggestedBet ? ' · ~$' + p.suggestedBet : '') +
                '</span>';
            var nameEl = card.querySelector('.pos-preset-name');
            var descEl = card.querySelector('.pos-preset-desc');
            if (nameEl) nameEl.textContent = currentLang === 'en' ? (p.en_name || p.name) : p.name;
            if (descEl) descEl.textContent = currentLang === 'en' ? (p.en_desc || p.desc) : p.desc;
            card.addEventListener('click', function() {
                applyBuiltinPreset(p.id);
            });
            grid.appendChild(card);
        });
        updatePresetTabHint();
    }

    function refreshBuiltinPresetLabels() {
        document.querySelectorAll('.pos-preset-tab').forEach(function(btn) {
            var exp = parseInt(btn.dataset.exp, 10);
            var meta = getPresetTabMeta(exp);
            btn.textContent = currentLang === 'en' ? meta.en_label : meta.label;
            btn.classList.toggle('active', activePresetExpTab === exp);
            btn.setAttribute('aria-selected', activePresetExpTab === exp ? 'true' : 'false');
        });
        document.querySelectorAll('.pos-preset-card').forEach(function(card) {
            var p = BUILTIN_PRESETS.find(function(x) { return x.id === card.dataset.presetId; });
            if (!p) return;
            var nameEl = card.querySelector('.pos-preset-name');
            var descEl = card.querySelector('.pos-preset-desc');
            if (nameEl) nameEl.textContent = currentLang === 'en' ? (p.en_name || p.name) : p.name;
            if (descEl) descEl.textContent = currentLang === 'en' ? (p.en_desc || p.desc) : p.desc;
            card.classList.toggle('active', activeBuiltinPresetId === p.id);
        });
        updatePresetTabHint();
    }

    function applyBuiltinPreset(id) {
        var p = BUILTIN_PRESETS.find(function(x) { return x.id === id; });
        if (!p) return;
        if (p.expiration) activePresetExpTab = p.expiration;
        applyPresetData(p, {
            builtinId: id,
            keepBet: !p.suggestedBet,
            applySuggestedBet: !!p.suggestedBet,
            keepAutoTrade: true,
            keepMM: true // пресет — про вход; систему ставок (мартингейл и т.д.) выбирает пользователь
        });
        buildPresetGrid();
        appendLog('✅ ' + t('preset_applied') + ': ' + (currentLang === 'en' ? (p.en_name || p.name) : p.name));
    }

    function resetIndConfigToDefaults() {
        Object.keys(indConfig).forEach(function(k) { delete indConfig[k]; });
        Object.keys(IND_PARAMS_META).forEach(function(id) {
            var meta = IND_PARAMS_META[id];
            if (!meta || !meta.length) return;
            indConfig[id] = {};
            meta.forEach(function(p) {
                indConfig[id][p.key] = p.def;
            });
        });
    }

    /** Снять активный пресет и вернуть классические параметры индикаторов - ручная настройка фильтров. */
    function clearBuiltinPreset() {
        activeBuiltinPresetId = null;
        setConfirmModeUI('auto');
        triggerPolicy = '';
        resetIndConfigToDefaults();
        renderIndParams();
        buildPresetGrid();

        var cfg = {
            selectedStrategies: selectedStrategies.slice(),
            filterMode: filterMode,
            indConfig: JSON.parse(JSON.stringify(indConfig)),
            activeBuiltinPresetId: null
        };
        saveSettings(cfg);
        if (window._posRunning) {
            patchRunningConfig({
                indicators: selectedStrategies.slice(),
                indicator: selectedStrategies[0] || 'RSI',
                filterMode: filterMode,
                indConfig: cfg.indConfig
            });
            refreshLiveBoard();
        }
        appendLog('↺ ' + t('preset_cleared'));
    }

    function exportPreset() {
        var preset = {
            _version: '2.0',
            selectedStrategies: selectedStrategies,
            filterMode: filterMode,
            confirmMode: confirmMode,
            triggerPolicy: triggerPolicy || undefined,
            moneyManagement: document.getElementById('pos-mm').value,
            baseBet: parseFloat(document.getElementById('pos-base-bet').value) || 1,
            multiplier: parseFloat(document.getElementById('pos-mult').value) || 2,
            maxSteps: parseInt(document.getElementById('pos-max-steps').value) || 5,
            parlaySteps: parseInt(document.getElementById('pos-steps').value) || 2,
            dalembertUnit: parseFloat(document.getElementById('pos-unit').value) || 1,
            labSequence: document.getElementById('pos-lab-seq').value || '1,2,3',
            startBalance: parseFloat(document.getElementById('pos-boost-balance').value) || 1000,
            expiration: normalizeExpiration(document.getElementById('pos-expiration').value),
            autoTrade: !!document.getElementById('pos-auto-trade')?.checked,
            htfFilter: !!document.getElementById('pos-htf-filter')?.checked,
            indConfig: JSON.parse(JSON.stringify(indConfig))
        };
        Object.assign(preset, collectRiskSettings());
        var blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        var chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        var rnd = '';
        for (var i = 0; i < 6; i++) rnd += chars.charAt(Math.floor(Math.random() * chars.length));
        a.href = url; a.download = 'pocketoption-' + rnd + '.json'; a.click();
        URL.revokeObjectURL(url);
        appendLog('✅ ' + t('preset_exported'));
    }

    function importPreset(file) {
        var reader = new FileReader();
        reader.onload = function(ev) {
            try {
                var data = JSON.parse(ev.target.result);
                applyPresetData(data, { builtinId: null, keepBet: false, keepAutoTrade: false });
                appendLog('✅ ' + t('preset_loaded'));
                checkAutoTradeGuards();
            } catch(err) {
                appendLog('❌ ' + t('preset_err'));
            }
        };
        reader.readAsText(file);
    }

    function applyPresetData(data, opts) {
        opts = opts || {};
        if (data.selectedStrategies && Array.isArray(data.selectedStrategies) && data.selectedStrategies.length) {
            selectedStrategies = data.selectedStrategies.slice();
            document.querySelectorAll('.pos-strat-card').forEach(function(c) {
                c.classList.toggle('sel', selectedStrategies.indexOf(c.dataset.id) >= 0);
            });
        }
        if (data.filterMode) {
            filterMode = data.filterMode;
            document.querySelectorAll('.pos-fm-btn:not(.pos-cm-btn)').forEach(function(b) {
                b.classList.toggle('active', b.dataset.mode === filterMode);
            });
            updateFilterModeHint();
        }
        if (data.confirmMode) setConfirmModeUI(data.confirmMode);
        triggerPolicy = data.triggerPolicy || '';
        var sv = function(id, v) { var e = document.getElementById(id); if (e && v != null) e.value = v; };
        if (!opts.keepMM) {
            if (data.moneyManagement) { sv('pos-mm', data.moneyManagement); updateMMExtra(); }
            sv('pos-mult', data.multiplier);
            sv('pos-max-steps', data.maxSteps);
            sv('pos-steps', data.parlaySteps);
            sv('pos-unit', data.dalembertUnit);
            sv('pos-lab-seq', data.labSequence);
        }
        if (!opts.keepBet) sv('pos-base-bet', data.baseBet);
        if (data.expiration != null) {
            sv('pos-expiration', normalizeExpiration(data.expiration));
            signalExpirationSec = normalizeExpiration(data.expiration);
            activePresetExpTab = snapPresetExpTab(data.expiration);
        }
        if (!opts.keepAutoTrade) {
            var autoImp = document.getElementById('pos-auto-trade');
            if (autoImp && data.autoTrade != null) {
                autoImp.checked = !!data.autoTrade;
                autoImp.setAttribute('aria-checked', autoImp.checked ? 'true' : 'false');
                if (autoImp.checked) beginAutoTradeSession();
            }
        }
        if (data.riskTpMode != null) sv('pos-tp-mode', data.riskTpMode || 'percent');
        if (data.riskTlMode != null) sv('pos-tl-mode', data.riskTlMode || 'percent');
        if (data.riskTpValue != null) sv('pos-tp-val', data.riskTpValue);
        if (data.riskTlValue != null) sv('pos-tl-val', data.riskTlValue);
        syncRiskSegmentUI();
        // Встроенные пресеты не включают лимиты TP/TL сами - пользователь должен активировать их вручную.
        // Собственный (импортированный) пресет восстанавливает состояние переключателя как было при экспорте.
        if (data.riskEnabled != null) {
            var riskEnableImp = document.getElementById('pos-risk-enable');
            var riskWrapImp = document.getElementById('pos-risk-wrap');
            if (riskEnableImp) {
                riskEnableImp.checked = !!data.riskEnabled;
                riskEnableImp.setAttribute('aria-checked', riskEnableImp.checked ? 'true' : 'false');
                if (riskWrapImp) riskWrapImp.style.display = riskEnableImp.checked ? 'block' : 'none';
            }
        }
        if (data.startBalance != null) sv('pos-boost-balance', data.startBalance);
        if (data.htfFilter != null) {
            var htfImp = document.getElementById('pos-htf-filter');
            if (htfImp) { htfImp.checked = !!data.htfFilter; saveSettings({ htfFilter: htfImp.checked }); }
        }
        if (opts.applySuggestedBet && data.suggestedBet != null) {
            sv('pos-base-bet', clampBaseBet(data.suggestedBet));
        }
        if (data.indConfig && typeof data.indConfig === 'object') {
            Object.keys(indConfig).forEach(function(k) { delete indConfig[k]; });
            Object.keys(data.indConfig).forEach(function(k) {
                indConfig[k] = Object.assign({}, data.indConfig[k]);
            });
            renderIndParams();
        }
        activeBuiltinPresetId = opts.builtinId || null;
        if (opts.builtinId) syncPresetTabFromActive();
        buildPresetGrid();

        var cfg = {
            indicators: selectedStrategies.slice(),
            indicator: selectedStrategies[0] || 'RSI',
            filterMode: filterMode,
            confirmMode: confirmMode,
            triggerPolicy: triggerPolicy || undefined,
            moneyManagement: (document.getElementById('pos-mm') || {}).value,
            baseBet: clampBaseBet((document.getElementById('pos-base-bet') || {}).value),
            multiplier: parseFloat((document.getElementById('pos-mult') || {}).value) || 2,
            maxSteps: parseInt((document.getElementById('pos-max-steps') || {}).value) || 5,
            parlaySteps: parseInt((document.getElementById('pos-steps') || {}).value) || 2,
            dalembertUnit: parseFloat((document.getElementById('pos-unit') || {}).value) || 1,
            labSequence: (document.getElementById('pos-lab-seq') || {}).value || '1,2,3',
            startBalance: parseFloat((document.getElementById('pos-boost-balance') || {}).value) || 1000,
            expiration: normalizeExpiration((document.getElementById('pos-expiration') || {}).value),
            htfFilter: !!(document.getElementById('pos-htf-filter') || {}).checked,
            indConfig: JSON.parse(JSON.stringify(indConfig)),
            autoTrade: !!(document.getElementById('pos-auto-trade') || {}).checked
        };
        Object.assign(cfg, collectRiskSettings());
        saveSettings(cfg);
        if (window._posRunning) {
            patchRunningConfig({
                indicators: cfg.indicators,
                indicator: cfg.indicator,
                filterMode: cfg.filterMode,
                confirmMode: cfg.confirmMode,
                triggerPolicy: cfg.triggerPolicy,
                moneyManagement: cfg.moneyManagement,
                baseBet: cfg.baseBet,
                multiplier: cfg.multiplier,
                maxSteps: cfg.maxSteps,
                parlaySteps: cfg.parlaySteps,
                dalembertUnit: cfg.dalembertUnit,
                labSequence: cfg.labSequence,
                expiration: cfg.expiration,
                htfFilter: cfg.htfFilter,
                indConfig: cfg.indConfig
            });
            mmState.init(cfg);
            updateIdleBet();
            updateLiveScan(buildLiveScanStub());
        }
        updateBetInputLimits();
    }

    // ── DEBUG STAT EDITOR (hidden, triple-click on version label) ──────
    function injectDebugPanel() {
        if (document.getElementById('pos-dbg')) return;
        var dbg = document.createElement('div');
        dbg.id = 'pos-dbg';
        dbg.style.cssText = 'display:none;position:fixed;bottom:12px;left:12px;z-index:2147483647;background:#0d1424;border:1px solid #1a2640;border-radius:10px;padding:14px 16px;width:200px;font-family:Inter,sans-serif;font-size:13px;color:#94a3b8;box-shadow:0 4px 20px rgba(0,0,0,.6)';
        dbg.innerHTML =
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
                '<span style="color:#4a5568;font-size:11px;font-weight:700;letter-spacing:.5px">STAT EDITOR</span>' +
                '<button id="pos-dbg-close" style="background:none;border:none;color:#4a5568;cursor:pointer;font-size:14px;line-height:1;padding:0">✕</button>' +
            '</div>' +
            '<div style="display:flex;flex-direction:column;gap:8px">' +
                '<label style="font-size:11px;color:#4a5568">Wins<input id="pos-dbg-wins" type="number" min="0" value="0" style="display:block;width:100%;margin-top:3px;background:#0a0f1e;border:1px solid #1a2640;border-radius:5px;color:#00e676;padding:5px 8px;font-size:13px;box-sizing:border-box"></label>' +
                '<label style="font-size:11px;color:#4a5568">Losses<input id="pos-dbg-losses" type="number" min="0" value="0" style="display:block;width:100%;margin-top:3px;background:#0a0f1e;border:1px solid #1a2640;border-radius:5px;color:#ff4d6d;padding:5px 8px;font-size:13px;box-sizing:border-box"></label>' +
                '<label style="font-size:11px;color:#4a5568">Profit $<input id="pos-dbg-profit" type="number" value="0" style="display:block;width:100%;margin-top:3px;background:#0a0f1e;border:1px solid #1a2640;border-radius:5px;color:#00d4ff;padding:5px 8px;font-size:13px;box-sizing:border-box"></label>' +
            '</div>' +
            '<div style="display:flex;gap:6px;margin-top:10px">' +
                '<button id="pos-dbg-apply" style="flex:1;background:#00d4ff;color:#0a0f1e;border:none;border-radius:5px;padding:6px 0;font-size:12px;font-weight:700;cursor:pointer">Apply</button>' +
                '<button id="pos-dbg-reset" style="flex:1;background:#1a2640;color:#94a3b8;border:none;border-radius:5px;padding:6px 0;font-size:12px;cursor:pointer">Reset</button>' +
            '</div>';
        document.body.appendChild(dbg);

        document.getElementById('pos-dbg-close').addEventListener('click', function() {
            dbg.style.display = 'none';
        });
        document.getElementById('pos-dbg-apply').addEventListener('click', function() {
            var w = Math.max(0, parseInt(document.getElementById('pos-dbg-wins').value) || 0);
            var l = Math.max(0, parseInt(document.getElementById('pos-dbg-losses').value) || 0);
            var p = parseFloat(document.getElementById('pos-dbg-profit').value) || 0;
            var tot = w + l;
            localStats.wins = w;
            localStats.losses = l;
            localStats.total = tot;
            localStats.totalProfit = parseFloat(p.toFixed(2));
            localStats.winRate = tot > 0 ? Math.round(w / tot * 100) : 0;
            updateStats(localStats);
        });
        document.getElementById('pos-dbg-reset').addEventListener('click', function() {
            document.getElementById('pos-dbg-wins').value = 0;
            document.getElementById('pos-dbg-losses').value = 0;
            document.getElementById('pos-dbg-profit').value = 0;
            localStats.wins = 0; localStats.losses = 0; localStats.total = 0;
            localStats.totalProfit = 0; localStats.winRate = 0;
            updateStats(localStats);
        });
    }

    function initDebugTrigger() {
        var logoEl = document.getElementById('pos-logo-mark');
        if (!logoEl) return;
        var clicks = 0, timer = null;
        logoEl.addEventListener('click', function() {
            clicks++;
            if (timer) clearTimeout(timer);
            timer = setTimeout(function() { clicks = 0; }, 600);
            if (clicks >= 3) {
                clicks = 0;
                injectDebugPanel();
                var dbg = document.getElementById('pos-dbg');
                if (dbg) dbg.style.display = dbg.style.display === 'none' ? 'block' : 'none';
            }
        });
    }

    function renderJournal() {
        var tbody = document.getElementById('qj-tbody');
        if (!tbody) return;
        if (journal.length === 0) {
            var etr = document.createElement('tr');
            var etd = document.createElement('td');
            etd.colSpan = 6; etd.className = 'qj-none'; etd.textContent = t('jrn_no_records');
            etr.appendChild(etd); tbody.textContent = ''; tbody.appendChild(etr);
            return;
        }
        tbody.textContent = '';
        var frag = document.createDocumentFragment();
        journal.slice(0, 100).forEach(function(tr) {
            var dCls = tr.direction === 'UP' ? 'qj-u' : 'qj-d';
            var rCls = tr.result === 'WIN' ? 'qj-w' : 'qj-l';
            var pl   = parseFloat(tr.profit || 0);
            var plStr = (pl >= 0 ? '+' : '-') + '$' + Math.abs(pl).toFixed(2);
            var row = document.createElement('tr');
            var cells = [tr.time, tr.asset, tr.direction, '$' + parseFloat(tr.bet).toFixed(2), tr.result, plStr];
            var cls   = ['', '', dCls, '', rCls, rCls];
            cells.forEach(function(val, i) {
                var td = document.createElement('td');
                if (cls[i]) td.className = cls[i];
                td.textContent = val;
                row.appendChild(td);
            });
            frag.appendChild(row);
        });
        tbody.appendChild(frag);
    }

    // ── DRAG ──────────────────────────────────────────────────────────
    function makeDraggable(elem, handle) {
        var x1=0, y1=0, x2=0, y2=0;
        handle.onmousedown = function(e) {
            if (e.target && e.target.closest && e.target.closest('#pos-min-btn')) return;
            e.preventDefault();
            x2 = e.clientX; y2 = e.clientY;
            document.onmousemove = function(ev) {
                x1 = x2 - ev.clientX; y1 = y2 - ev.clientY;
                x2 = ev.clientX;      y2 = ev.clientY;
                elem.style.top   = (elem.offsetTop  - y1) + 'px';
                elem.style.left  = (elem.offsetLeft - x1) + 'px';
                elem.style.right = 'auto';
            };
            document.onmouseup = function() { document.onmousemove = null; document.onmouseup = null; };
        };
    }

    // ── SETTINGS ─────────────────────────────────────────────────────
    function saveSettings(config) {
        if (typeof chrome === 'undefined' || !chrome.storage) return;
        chrome.storage.local.set(Object.assign({}, config, {
            selectedStrategies: selectedStrategies,
            filterMode: filterMode,
            confirmMode: confirmMode,
            triggerPolicy: triggerPolicy || '',
            indConfig: indConfig,
            pos_lang: currentLang,
            activeBuiltinPresetId: activeBuiltinPresetId,
            activePresetExpTab: activePresetExpTab
        }));
    }

    function loadSettings() {
        if (typeof chrome === 'undefined' || !chrome.storage) { renderIndParams(); applyBotLang(); return; }
        chrome.storage.local.get(null, function(data) {
            if (data.pos_lang === 'en' || data.pos_lang === 'ru') { currentLang = data.pos_lang; }
            if (data.selectedStrategies && Array.isArray(data.selectedStrategies) && data.selectedStrategies.length > 0) {
                selectedStrategies = data.selectedStrategies.slice();
            } else if (data.selectedStrategy) {
                selectedStrategies = [data.selectedStrategy];
            }
            document.querySelectorAll('.pos-strat-card').forEach(function(c) {
                c.classList.toggle('sel', selectedStrategies.indexOf(c.dataset.id) >= 0);
            });
            if (data.filterMode) {
                filterMode = data.filterMode;
                document.querySelectorAll('.pos-fm-btn:not(.pos-cm-btn)').forEach(function(b) {
                    b.classList.toggle('active', b.dataset.mode === filterMode);
                });
            }
            if (data.confirmMode) setConfirmModeUI(data.confirmMode);
            if (data.triggerPolicy) triggerPolicy = data.triggerPolicy;
            var sv = function(id, v) { var e = document.getElementById(id); if (e && v != null) e.value = v; };
            if (data.moneyManagement) { sv('pos-mm', data.moneyManagement); updateMMExtra(); }
            sv('pos-base-bet',    data.baseBet);
            sv('pos-mult',        data.multiplier);
            sv('pos-steps',       data.parlaySteps);
            sv('pos-unit',          data.dalembertUnit);
            sv('pos-lab-seq',        data.labSequence);
            // Стартовый баланс из storage не затирает живой баланс с сайта
            if (!(window._poActiveBalance != null && window._poActiveBalance > 0)) {
                sv('pos-boost-balance',  data.startBalance);
            }
            sv('pos-max-steps',      data.maxSteps);
            sv('pos-expiration',     normalizeExpiration(data.expiration));
            sv('pos-min-profit', data.minProfit != null ? data.minProfit : 92);
            sv('pos-max-concurrent', data.maxConcurrentTrades != null ? data.maxConcurrentTrades : 4);
            var multiPairEl = document.getElementById('pos-multi-pair');
            if (multiPairEl) multiPairEl.checked = data.multiPairTrading !== false;
            var otcEl = document.getElementById('pos-include-otc');
            if (otcEl) otcEl.checked = data.includeOtc !== false;
            var reverseEl = document.getElementById('pos-reverse-enabled');
            if (reverseEl) {
                reverseEl.checked = !!data.reverseEnabled;
                reverseEl.setAttribute('aria-checked', reverseEl.checked ? 'true' : 'false');
            }
            var reverseWinsEl = document.getElementById('pos-reverse-wins');
            if (reverseWinsEl) reverseWinsEl.value = data.reverseWins != null ? Math.max(1, Math.min(10, parseInt(data.reverseWins, 10) || 3)) : 3;
            var reverseWinsValue = document.getElementById('pos-reverse-wins-value');
            if (reverseWinsValue && reverseWinsEl) reverseWinsValue.textContent = reverseWinsEl.value;
            signalExpirationSec = normalizeExpiration(data.expiration);
            ['pos-multi-pair', 'pos-min-profit', 'pos-max-concurrent', 'pos-include-otc', 'pos-reverse-enabled', 'pos-reverse-wins'].forEach(function(id) {
                var el = document.getElementById(id);
                if (!el || el._posBound) return;
                el._posBound = true;
                el.addEventListener('change', function() {
                    if (id === 'pos-reverse-wins') {
                        var output = document.getElementById('pos-reverse-wins-value');
                        if (output) output.textContent = el.value;
                    }
                    if (id === 'pos-reverse-enabled') el.setAttribute('aria-checked', el.checked ? 'true' : 'false');
                    var patch = {
                        multiPairTrading: !!(document.getElementById('pos-multi-pair') || {}).checked,
                        minProfit: parseFloat((document.getElementById('pos-min-profit') || {}).value || '92'),
                        maxConcurrentTrades: parseInt((document.getElementById('pos-max-concurrent') || {}).value || '4', 10),
                        includeOtc: !!(document.getElementById('pos-include-otc') || {}).checked,
                        reverseEnabled: !!(document.getElementById('pos-reverse-enabled') || {}).checked,
                        reverseWins: Math.max(1, Math.min(10, parseInt((document.getElementById('pos-reverse-wins') || {}).value || '3', 10)))
                    };
                    saveSettings(patch);
                    if (window._posRunning) sendCoreCmd({ cmd: 'PATCH_CONFIG', patch: patch });
                });
            });
            var reverseRange = document.getElementById('pos-reverse-wins');
            if (reverseRange && !reverseRange._posInputBound) {
                reverseRange._posInputBound = true;
                reverseRange.addEventListener('input', function() {
                    var output = document.getElementById('pos-reverse-wins-value');
                    if (output) output.textContent = reverseRange.value;
                });
            }
            var autoEl = document.getElementById('pos-auto-trade');
            if (autoEl) {
                autoEl.checked = !!data.autoTrade;
                autoEl.setAttribute('aria-checked', autoEl.checked ? 'true' : 'false');
                if (autoEl.checked) beginAutoTradeSession();
            }
            var htfEl = document.getElementById('pos-htf-filter');
            if (htfEl) {
                htfEl.checked = !!data.htfFilter;
                htfEl.setAttribute('aria-checked', htfEl.checked ? 'true' : 'false');
            }
            var chartOverlayEl = document.getElementById('pos-chart-ind-sync');
            if (chartOverlayEl) {
                chartOverlayEl.checked = !!data.chartOverlay;
                chartOverlayEl.setAttribute('aria-checked', chartOverlayEl.checked ? 'true' : 'false');
            }
            // оверлей включается по галочке сразу, без «Запустить анализ»
            setTimeout(function() { try { syncChartOverlayToCore(); } catch (_) {} }, 400);
            var streakGuardEl = document.getElementById('pos-streak-guard');
            var streakRow = document.getElementById('pos-streak-guard-row');
            if (streakGuardEl) {
                streakGuardEl.checked = !!data.streakGuard;
                streakGuardEl.setAttribute('aria-checked', streakGuardEl.checked ? 'true' : 'false');
                if (streakRow) streakRow.style.display = streakGuardEl.checked ? 'grid' : 'none';
            }
            sv('pos-streak-limit', data.streakLimit != null ? data.streakLimit : 3);
            sv('pos-streak-pause', data.streakPauseMin != null ? data.streakPauseMin : 10);
            var setSel = function(id, v) { var e = document.getElementById(id); if (e && v != null) e.value = v; };
            setSel('pos-tp-mode', data.riskTpMode || 'percent');
            setSel('pos-tl-mode', data.riskTlMode || 'percent');
            if (data.riskTpValue != null) setSel('pos-tp-val', data.riskTpValue);
            if (data.riskTlValue != null) setSel('pos-tl-val', data.riskTlValue);
            syncRiskSegmentUI();
            var riskEnableEl = document.getElementById('pos-risk-enable');
            var riskWrap = document.getElementById('pos-risk-wrap');
            if (riskEnableEl) {
                riskEnableEl.checked = !!data.riskEnabled;
                riskEnableEl.setAttribute('aria-checked', riskEnableEl.checked ? 'true' : 'false');
                if (riskWrap) riskWrap.style.display = riskEnableEl.checked ? 'block' : 'none';
            }
            if (data.indConfig && typeof data.indConfig === 'object') {
                Object.assign(indConfig, data.indConfig);
            }
            if (data.activeBuiltinPresetId) {
                activeBuiltinPresetId = String(data.activeBuiltinPresetId).replace(/^s120_/, 's180_');
            }
            if (data.activePresetExpTab) {
                activePresetExpTab = parseInt(data.activePresetExpTab, 10) || activePresetExpTab;
            }
            syncPresetTabFromActive();
            buildPresetGrid();
            renderIndParams();
            applyBotLang();
            updateBetInputLimits();
            updateFilterModeHint();
            var baseBetLoaded = document.getElementById('pos-base-bet');
            if (baseBetLoaded) baseBetLoaded.value = clampBaseBet(baseBetLoaded.value);
            refreshAllBalanceDisplays();
            checkAutoTradeGuards();
        });
    }

    // ── ACCOUNT BALANCE & BET LIMITS ─────────────────────────────────
    window._poActiveBalance = null;
    window._poAccountType = 'demo';
    window._poDemoBalance = null;
    window._poRealBalance = null;
    window._poBalanceUpdatedAt = 0;

    function getAvailableBalance() {
        if (window._poActiveBalance != null && !isNaN(window._poActiveBalance)) return window._poActiveBalance;
        if (window._poAccountType === 'real' && window._poRealBalance != null) return window._poRealBalance;
        if (window._poAccountType === 'demo' && window._poDemoBalance != null) return window._poDemoBalance;
        if (window._poDemoBalance != null) return window._poDemoBalance;
        return window._poRealBalance;
    }

    function formatMoney(v) {
        var n = parseFloat(v);
        if (isNaN(n)) return '-';
        return '$' + n.toFixed(2);
    }

    function clampBaseBet(value) {
        var v = parseFloat(value);
        if (isNaN(v) || v <= 0) v = 1;
        var maxBal = getAvailableBalance();
        if (maxBal != null && maxBal > 0) v = Math.min(v, maxBal);
        var minBet = (maxBal != null && maxBal < 1) ? Math.max(0.01, maxBal) : 1;
        v = Math.max(v, minBet);
        return parseFloat(v.toFixed(2));
    }

    function updateBetInputLimits() {
        var inp = document.getElementById('pos-base-bet');
        var hint = document.getElementById('pos-bet-max-hint');
        var maxBal = getAvailableBalance();
        if (!inp) return maxBal;
        if (maxBal != null && maxBal > 0) {
            inp.max = maxBal.toFixed(2);
            var minBet = maxBal < 1 ? Math.max(0.01, maxBal) : 1;
            inp.min = String(minBet);
            if (hint) hint.textContent = t('bet_max') + ' $' + maxBal.toFixed(2);
        } else if (hint) {
            hint.textContent = '';
        }
        return maxBal;
    }

    function inferAccountType(data) {
        var bal = data.balance;
        var demo = data.demoBalance != null ? data.demoBalance : window._poDemoBalance;
        var real = data.realBalance != null ? data.realBalance : window._poRealBalance;
        if (data.accountType === 'demo' || data.accountType === 'real') {
            if (bal != null && demo != null && real != null) {
                if (data.accountType === 'demo' && Math.abs(bal - real) < 0.02 && Math.abs(bal - demo) >= 0.02) return 'real';
                if (data.accountType === 'real' && Math.abs(bal - demo) < 0.02 && Math.abs(bal - real) >= 0.02) return 'demo';
            }
            return data.accountType;
        }
        if (bal != null && demo != null && real != null) {
            if (Math.abs(bal - real) < 0.02 && Math.abs(bal - demo) >= 0.02) return 'real';
            if (Math.abs(bal - demo) < 0.02 && Math.abs(bal - real) >= 0.02) return 'demo';
        }
        return window._poAccountType || 'demo';
    }

    /** Обновляет все виджеты баланса в панели из текущих window._po* значений */
    function refreshAllBalanceDisplays() {
        var bal = getAvailableBalance();
        var type = window._poAccountType || 'demo';
        var isDemo = type === 'demo';

        var typeEl = document.getElementById('pos-account-type');
        if (typeEl) {
            typeEl.textContent = isDemo ? t('acct_demo') : t('acct_real');
            typeEl.className = 'pos-account-badge ' + (isDemo ? 'demo' : 'real');
        }

        var balEl = document.getElementById('pos-account-bal');
        if (balEl) balEl.textContent = bal != null ? formatMoney(bal) : '-';

        updateBetInputLimits();

        var boostBalEl = document.getElementById('pos-boost-bal');
        if (boostBalEl && bal != null) boostBalEl.textContent = formatMoney(bal);

        var boostInfo = document.getElementById('pos-boost-info');
        if (boostInfo && typeof mmState !== 'undefined' && mmState.strategy === 'boost') {
            boostInfo.style.display = 'block';
        }

        var boostInp = document.getElementById('pos-boost-balance');
        if (boostInp && bal != null && bal > 0) {
            var curInp = parseFloat(boostInp.value);
            // Всегда держим поле стартового баланса = живой баланс (кроме активного ввода)
            if (document.activeElement !== boostInp) {
                if (isNaN(curInp) || Math.abs(curInp - bal) >= 0.005) {
                    boostInp.value = bal.toFixed(2);
                    if (typeof mmState !== 'undefined' && mmState.strategy === 'boost') {
                        mmState.startBalance = bal;
                    }
                }
            }
        }

        var baseBetEl = document.getElementById('pos-base-bet');
        if (baseBetEl && bal != null && document.activeElement !== baseBetEl) {
            var clamped = clampBaseBet(baseBetEl.value);
            if (Math.abs(parseFloat(baseBetEl.value) - clamped) >= 0.005) {
                baseBetEl.value = clamped;
                saveSettings({ baseBet: clamped });
                if (window._posRunning) {
                    sendCoreCmd({ cmd: 'PATCH_CONFIG', patch: { baseBet: clamped } });
                }
            }
        }

        var maxHint = document.getElementById('pos-bet-max-hint');
        if (maxHint && bal != null && bal > 0) {
            maxHint.textContent = t('bet_max') + ' $' + bal.toFixed(2);
        }

        updateIdleBet();
        checkAutoTradeGuards();
    }

    function syncAccountBalanceUI(data) {
        if (!data) data = {};

        // Игнорируем устаревшие сообщения (iframe/старый WS)
        var msgTs = data.ts != null ? parseInt(data.ts, 10) : Date.now();
        if (window._poBalanceMsgTs && msgTs + 50 < window._poBalanceMsgTs) return;
        if (data.source && data.source !== 'top-dom' && window._poBalanceMsgTs &&
            (Date.now() - window._poBalanceMsgTs) < 2500) {
            return;
        }

        if (data.demoBalance != null && !isNaN(data.demoBalance)) window._poDemoBalance = data.demoBalance;
        if (data.realBalance != null && !isNaN(data.realBalance)) window._poRealBalance = data.realBalance;

        var resolvedType = inferAccountType({
            balance: data.balance != null ? data.balance : window._poActiveBalance,
            accountType: data.accountType,
            demoBalance: window._poDemoBalance,
            realBalance: window._poRealBalance
        });
        window._poAccountType = resolvedType;

        // Пришедший balance с сайта - главный источник истины
        if (data.balance != null && !isNaN(data.balance) && data.balance >= 0) {
            window._poActiveBalance = data.balance;
            if (resolvedType === 'demo') window._poDemoBalance = data.balance;
            if (resolvedType === 'real') window._poRealBalance = data.balance;
        } else if (resolvedType === 'demo' && window._poDemoBalance != null) {
            window._poActiveBalance = window._poDemoBalance;
        } else if (resolvedType === 'real' && window._poRealBalance != null) {
            window._poActiveBalance = window._poRealBalance;
        }

        window._poBalanceMsgTs = msgTs;
        window._poBalanceUpdatedAt = Date.now();
        refreshAllBalanceDisplays();
        checkAutoTradeGuards();

        if (typeof mmState !== 'undefined' && mmState.strategy === 'boost' && typeof localStats !== 'undefined') {
            showBoostTip(localStats.totalProfit || 0);
        }
    }

    // ── REAL BALANCE UPDATE ────────────────────────────────────────────
    function updateRealBalance(bal) {
        if (bal == null || isNaN(bal)) return;
        window._poActiveBalance = bal;
        refreshAllBalanceDisplays();
    }

    // ── BOOST TIP ─────────────────────────────────────────────────────
    var _lastBoostApplied = null;
    function showBoostTip(totalProfit) {
        var infoEl = document.getElementById('pos-boost-info');
        var tipEl  = document.getElementById('pos-boost-tip');
        if (!infoEl || !tipEl) return;
        if (mmState.strategy !== 'boost') {
            infoEl.style.display = 'none';
            tipEl.style.display  = 'none';
            return;
        }
        var liveBal = getAvailableBalance();
        var curBal = (liveBal != null) ? liveBal : (mmState.startBalance + totalProfit);
        var balEl  = document.getElementById('pos-boost-bal');
        if (balEl) balEl.textContent = formatMoney(curBal);
        infoEl.style.display = 'block';
        tipEl.style.display  = 'none';
        var suggested = mmState.getBoostSuggestion(totalProfit);
        if (suggested !== null && suggested !== _lastBoostApplied) {
            _lastBoostApplied = suggested;
            var tipValEl = document.getElementById('pos-boost-tip-val');
            if (tipValEl) tipValEl.textContent = formatMoney(suggested);
            tipEl.style.display = 'block';
        }
    }

    // ── AUTO RESULT (from platform notifications) ─────────────────────
    /** Ядро (inject.js MoneyManager) прислало следующую ставку и шаг — панель показывает то же, что уйдёт на PO. */
    function syncMMFromCore(core) {
        if (!core || core.nextBet == null || isNaN(parseFloat(core.nextBet))) return;
        if (core.mm && core.mm !== mmState.strategy) return;
        mmState.currentBet = parseFloat(core.nextBet);
        if (core.mmStep != null && !isNaN(parseInt(core.mmStep, 10))) mmState.step = parseInt(core.mmStep, 10);
    }

    function autoRecordResult(result, profit, core) {
        if (!currentSignal) {
            // сделка без карточки (режим ЛЮБОЙ, несколько сделок) — прогрессию всё равно ведём
            if (core && core.nextBet != null) { syncMMFromCore(core); updateIdleBet(); }
            return;
        }
        var sig = currentSignal;
        dismissSignal();
        mmState.onResult(result);
        syncMMFromCore(core);
        updateIdleBet();
        // For LOSE always use the bot's tracked bet (Martingale-adjusted), not API profit which may be base amount
        // For WIN: if API returned total return (stake+profit), subtract stake to get net profit
        var pl = netPnlFromResult(result, profit, sig.amount);
        applySessionPnl(result, pl);
        updateStreak(result);
        var now = new Date();
        var ts = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0') + ':' + String(now.getSeconds()).padStart(2,'0');
        var stratKey = selectedStrategies.slice().sort().join('+') + ' [' + filterMode + ']';
        addTradeToJournal({ time: ts, asset: sig.asset, direction: sig.direction, bet: sig.amount, result: result, profit: pl.toFixed(2), strategy: stratKey });
        posTelemetryTrade(sig, result, pl, stratKey, true);
        var pSign = pl >= 0 ? '+' : '-';
        var tSign = localStats.totalProfit >= 0 ? '+' : '-';
        appendLog((result === 'WIN' ? '✅' : '❌') + ' [' + sig.asset + '] ' + result + t('auto_suffix') + ' | P&L: ' + pSign + '$' + Math.abs(pl).toFixed(2) + t('total_suffix') + tSign + '$' + Math.abs(localStats.totalProfit).toFixed(2));
        showTradeReaction(result);
        showBoostTip(localStats.totalProfit);
        checkAutoTradeGuards();
    }


    // ── PREDICTIVE ENGINE UI / STORAGE ────────────────────────────────
    var pt4Predictive = { latest: {}, warmup: {}, indicators: {}, state: null, config: null, saveTimer: null, lastIndicator: null, restored: false };
    var PT4_MODEL_NAMES = { linear:'Линейная', exponential:'Экспоненциальная', polynomial:'Полиномиальная', momentum:'Momentum', cyclical:'Циклическая', ensemble:'Ансамбль' };
    function pt4DefaultConfig() {
        return { enabled:true, sourceMode:'formula', assetMode:'all', selectedAsset:'*', horizonSeconds:60, model:'auto',
            confidenceFloor:0.60, autoTrade:false, accountMode:'demo', stake:1, maxConcurrentTrades:1 };
    }
    function pt4ReadConfig() {
        var selectedAsset = document.getElementById('pt4-asset').value || '*';
        return {
            enabled:true, sourceMode:document.getElementById('pt4-source').value,
            assetMode:selectedAsset === '*' ? 'all' : 'selected', selectedAsset:selectedAsset,
            horizonSeconds:parseInt(document.getElementById('pt4-horizon').value,10)||60,
            model:document.getElementById('pt4-model').value,
            confidenceFloor:(parseInt(document.getElementById('pt4-confidence').value,10)||52)/100,
            autoTrade:document.getElementById('pt4-auto-trade').checked,
            accountMode:document.getElementById('pt4-account').value,
            stake:Math.max(1,Math.min(100000,Number(document.getElementById('pt4-stake').value)||1)),
            maxConcurrentTrades:Math.max(1,Math.min(20,parseInt(document.getElementById('pt4-max-trades').value,10)||1))
        };
    }
    function pt4ApplyConfig(c) {
        var v=Object.assign(pt4DefaultConfig(),c||{}); pt4Predictive.config=v;
        document.getElementById('pt4-source').value=v.sourceMode;
        pt4UpdateModeControls();
        document.getElementById('pt4-horizon').value=String(v.horizonSeconds);
        document.getElementById('pt4-model').value=v.model;
        document.getElementById('pt4-confidence').value=Math.round(v.confidenceFloor*100);
        document.getElementById('pt4-confidence-value').textContent=Math.round(v.confidenceFloor*100)+'%';
        document.getElementById('pt4-auto-trade').checked=!!v.autoTrade;
        document.getElementById('pt4-account').value=v.accountMode;
        document.getElementById('pt4-stake').value=v.stake;
        document.getElementById('pt4-max-trades').value=v.maxConcurrentTrades;
        var asset=document.getElementById('pt4-asset');
        if(v.selectedAsset && !Array.from(asset.options).some(function(o){return o.value===v.selectedAsset;})) { var opt=document.createElement('option'); opt.value=v.selectedAsset; opt.textContent=v.selectedAsset; asset.appendChild(opt); }
        if(v.selectedAsset) asset.value=v.selectedAsset;
        window.postMessage({type:'PT4_PREDICTIVE_CONFIG',config:{
            enabled:true, confidenceFloor:v.confidenceFloor, minEvaluationSamples:30,
            predictive:v
        }},'*');
    }
    function initPredictiveUI() {
        var ids=['pt4-source','pt4-horizon','pt4-model','pt4-confidence','pt4-auto-trade','pt4-account','pt4-stake','pt4-max-trades','pt4-asset'];
        ids.forEach(function(id){var el=document.getElementById(id);if(el)el.addEventListener('change',function(){pt4Predictive.config=pt4ReadConfig();});});
        document.getElementById('pt4-confidence').addEventListener('input',function(){document.getElementById('pt4-confidence-value').textContent=this.value+'%';});
        document.getElementById('pt4-save').addEventListener('click',savePredictiveConfig);
        document.getElementById('pt4-source').addEventListener('change',pt4UpdateModeControls);
        try { chrome.storage.local.get(['pt4PredictiveConfig'],function(data){if(data&&data.pt4PredictiveConfig)pt4ApplyConfig(data.pt4PredictiveConfig);else pt4ApplyConfig(pt4DefaultConfig());}); }
        catch(_) { pt4ApplyConfig(pt4DefaultConfig()); }
        window.postMessage({type:'PT4_PREDICTIVE_HELLO'},'*');
    }
    function pt4UpdateModeControls() {
        var indicatorOnly = document.getElementById('pt4-source').value === 'indicators';
        var auto = document.getElementById('pt4-auto-trade');
        auto.disabled = indicatorOnly;
        auto.title = indicatorOnly ? 'В режиме «Только индикаторы» сделки контролируются основным модулем сигналов.' : '';
        if (indicatorOnly) document.getElementById('pt4-signal-status').textContent = 'Только индикаторы: автоторговля управляется основным модулем';
    }
    function savePredictiveConfig() {
        var c=pt4ReadConfig();
        if(c.autoTrade && (!Number.isFinite(c.stake)||c.stake<=0)){appendLog('Predictive: некорректная ставка.');return;}
        pt4Predictive.config=c;
        try { chrome.storage.local.set({pt4PredictiveConfig:c},function(){
            var storageError=chrome.runtime.lastError;
            window.postMessage({type:'PT4_PREDICTIVE_CONFIG',config:{enabled:true,confidenceFloor:c.confidenceFloor,minEvaluationSamples:30,predictive:c}},'*');
            document.getElementById('pt4-signal-status').textContent=c.autoTrade?'Автоторговля включена в настройках':'Автоторговля выключена';
            if(storageError)appendLog('Predictive: настройки применены, но не сохранены — '+storageError.message);
            else appendLog('Predictive: настройки сохранены.');
        }); } catch(error) {
            window.postMessage({type:'PT4_PREDICTIVE_CONFIG',config:{enabled:true,confidenceFloor:c.confidenceFloor,minEvaluationSamples:30,predictive:c}},'*');
            appendLog('Predictive: настройки применены только до перезагрузки — '+(error&&error.message||'storage'));
        }
    }
    function restorePredictiveState() {
        if(pt4Predictive.restored)return;
        pt4Predictive.restored=true;
        try { chrome.storage.local.get(['pt4PredictiveState','pt4PredictiveConfig'],function(data){
            if(data&&data.pt4PredictiveState)window.postMessage({type:'PT4_PREDICTIVE_RESTORE',state:data.pt4PredictiveState},'*');
            if(data&&data.pt4PredictiveConfig)pt4ApplyConfig(data.pt4PredictiveConfig);
        }); } catch(_) {}
    }
    function handlePredictiveEvent(message) {
        if(!message||!message.eventType)return;
        if(message.eventType==='forecast')handlePredictiveForecast(message.payload);
        if(message.eventType==='settled')appendLog('Predictive: проверен '+message.payload.asset+' · '+message.payload.horizon+'с · '+message.payload.actualDirection);
        if(message.eventType==='invalid')appendLog('Predictive: прогноз '+message.payload.asset+' помечен недействительным (запоздалая котировка).');
        if(message.eventType==='settlement_batch'){
            var settledCount=(message.payload.settled||[]).length, invalidCount=(message.payload.invalid||[]).length;
            if(settledCount||invalidCount)appendLog('Predictive ['+message.payload.asset+']: проверено '+settledCount+' прогнозов; недействительных из-за задержки '+invalidCount+'.');
        }
        if(message.state){
            pt4Predictive.state=message.state;
            if(!pt4Predictive.saveTimer)pt4Predictive.saveTimer=setTimeout(function(){
                pt4Predictive.saveTimer=null;
                try{chrome.storage.local.set({pt4PredictiveState:pt4Predictive.state},function(){if(chrome.runtime.lastError)appendLog('Predictive: не удалось сохранить статистику — '+chrome.runtime.lastError.message);});}catch(error){appendLog('Predictive: ошибка сохранения статистики — '+(error&&error.message||'storage'));}
            },2500);
        }
        renderPredictivePanel();
    }
    function handlePredictiveForecast(forecast) {
        if(!forecast||!forecast.asset||!forecast.horizons)return;
        pt4Predictive.latest[forecast.asset]=forecast; pt4Predictive.lastAsset=forecast.asset;
        var select=document.getElementById('pt4-asset'), selected=select.value;
        if(!Array.from(select.options).some(function(o){return o.value===forecast.asset;})){
            var opt=document.createElement('option');opt.value=forecast.asset;opt.textContent=forecast.asset;select.appendChild(opt);
        }
        if(selected && selected!=='*') select.value=selected;
        renderPredictivePanel();
    }
    function pt4FormatPrice(value) {
        if(!Number.isFinite(Number(value)))return '—';
        return Number(value).toPrecision(7);
    }
    function renderPredictivePanel() {
        var cfg=pt4Predictive.config||pt4DefaultConfig(), select=document.getElementById('pt4-asset');
        if(!select)return;
        var asset=select.value==='*'?(pt4Predictive.lastAsset||Object.keys(pt4Predictive.latest).slice(-1)[0]||''):select.value;
        var forecast=pt4Predictive.latest[asset], horizon=parseInt(document.getElementById('pt4-horizon').value,10)||60;
        var row=forecast&&forecast.horizons&&forecast.horizons[horizon];
        var warm=pt4Predictive.warmup[asset];
        document.getElementById('pt4-feed-status').textContent=forecast?'OTC · ПОТОК АКТИВЕН':(warm?'ИСТОРИЯ '+warm.samples+'/'+warm.required:'ОЖИДАНИЕ OTC');
        document.getElementById('pt4-current-asset').textContent=asset||'Ожидание котировок';
        document.getElementById('pt4-issued-at').textContent=forecast?new Date(forecast.timestamp).toLocaleTimeString():'—';
        document.getElementById('pt4-current-price').textContent=forecast?pt4FormatPrice(forecast.currentPrice):'—';
        var target=row?row.price:null;
        if(row && cfg.model!=='auto' && row.models[cfg.model]!=null)target=row.models[cfg.model];
        document.getElementById('pt4-target-price').textContent=target==null?'—':pt4FormatPrice(target);
        var dir=target==null?'—':target>forecast.currentPrice?'UP ▲':target<forecast.currentPrice?'DOWN ▼':'DRAW';
        var dirEl=document.getElementById('pt4-direction');dirEl.textContent=dir;dirEl.className=dir.indexOf('UP')===0?'pt4-up':dir.indexOf('DOWN')===0?'pt4-down':'';
        var confidence=row?(cfg.model==='auto'?row.confidence:(row.modelConfidence&&row.modelConfidence[cfg.model]!=null?row.modelConfidence[cfg.model]:0.5)):null;
        var confidenceSamples=row?(cfg.model==='auto'?row.confidenceSamples:(row.modelConfidenceSamples&&row.modelConfidenceSamples[cfg.model]||0)):0;
        document.getElementById('pt4-confidence-out').textContent=confidence==null?'—':Math.round(confidence*100)+'%'+(confidenceSamples>=30?' · n='+confidenceSamples:' · мало данных');
        var eligible=!!(row&&(cfg.model==='auto'?row.eligible:(row.modelEligible&&row.modelEligible[cfg.model]))&&confidence>=cfg.confidenceFloor&&dir!=='DRAW');
        var source=cfg.sourceMode;
        var indicator=pt4Predictive.indicators[asset] || pt4Predictive.lastIndicator;
        if(indicator && indicator.timestamp && Date.now()-indicator.timestamp>12000)indicator=null;
        var sourceText=source==='indicators'?'Только индикаторы · сделки управляются основным модулем':source==='combined'?'Ожидание совпадения направлений':'Predictive Formula';
        if(source==='indicators') eligible=false;
        if(source==='combined' && indicator && indicator.direction && dir.indexOf(indicator.direction)===0)sourceText='Совпадение индикаторов и прогноза';
        else if(source==='combined' && indicator && indicator.direction && dir!=='—' && indicator.direction!==dir.replace(/ .*/,''))sourceText='КОНФЛИКТ · вход запрещён';
        document.getElementById('pt4-signal-status').textContent=sourceText+(eligible?' · порог пройден':' · нет допуска');
        renderPredictiveChart(forecast,cfg.model);
        renderPredictiveModels(forecast,horizon,asset);
        renderPredictiveLastResult(asset,horizon);
    }
    function renderPredictiveChart(forecast,model) {
        var canvas=document.getElementById('pt4-chart');if(!canvas)return;
        var ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
        ctx.clearRect(0,0,w,h);ctx.strokeStyle='rgba(255,255,255,.10)';ctx.lineWidth=1;
        for(var i=1;i<5;i++){var y=i*h/5;ctx.beginPath();ctx.moveTo(30,y);ctx.lineTo(w-12,y);ctx.stroke();}
        if(!forecast){ctx.fillStyle='#9ca3af';ctx.font='20px sans-serif';ctx.fillText('Ожидание котировок OTC…',35,h/2);return;}
        var points=[{x:0,y:forecast.currentPrice}];
        [60,120,180,240,300].forEach(function(sec){var r=forecast.horizons[sec];if(r){var target=model&&model!=='auto'&&r.models[model]!=null?r.models[model]:r.price;points.push({x:sec,y:target});}});
        var vals=points.map(p=>p.y),min=Math.min.apply(null,vals),max=Math.max.apply(null,vals),pad=(max-min)*.18||Math.abs(max)*.00001||1;
        min-=pad;max+=pad;
        function px(x){return 30+(w-48)*x/300;}function py(y){return h-24-(h-48)*(y-min)/(max-min);}
        ctx.strokeStyle='#d4af37';ctx.lineWidth=3;ctx.beginPath();
        points.forEach(function(p,i){if(i===0)ctx.moveTo(px(p.x),py(p.y));else ctx.lineTo(px(p.x),py(p.y));});ctx.stroke();
        points.forEach(function(p,i){ctx.beginPath();ctx.arc(px(p.x),py(p.y),i?5:7,0,Math.PI*2);ctx.fillStyle=i?'#d4af37':'#f8fafc';ctx.fill();});
        ctx.fillStyle='#9ca3af';ctx.font='15px sans-serif';ctx.fillText('NOW',20,h-5);
        [60,120,180,240,300].forEach(function(sec){ctx.fillText((sec/60)+'m',px(sec)-12,h-5);});
    }
    function renderPredictiveLastResult(asset,horizon) {
        var el=document.getElementById('pt4-last-result');if(!el)return;
        var history=pt4Predictive.state&&pt4Predictive.state.history||[];
        var record=null;
        for(var i=history.length-1;i>=0;i--){
            if(history[i]&&history[i].asset===asset&&Number(history[i].horizon)===Number(horizon)){record=history[i];break;}
        }
        if(!record){el.textContent='Последняя фактическая проверка: —';return;}
        if(record.status!=='SETTLED'){
            el.textContent='Последняя проверка: прогноз недействителен ('+(record.status||'UNKNOWN')+').';
            return;
        }
        el.textContent='Факт: '+pt4FormatPrice(record.actualPrice)+' · '+record.actualDirection+
            ' · модель '+(PT4_MODEL_NAMES[record.model]||record.model)+
            ' · ошибка '+(Number(record.actualError)*100).toFixed(3)+'%.';
    }
    function renderPredictiveModels(forecast,horizon,asset) {
        var tbody=document.getElementById('pt4-model-rows');if(!tbody)return;
        tbody.innerHTML='';var models=['linear','exponential','polynomial','momentum','cyclical','ensemble'];
        var statsMap={};var stats=pt4Predictive.state&&pt4Predictive.state.stats||[];
        stats.forEach(function(pair){if(Array.isArray(pair)&&pair[0])statsMap[pair[0]]=pair[1];});
        var decisiveTotal=0;
        models.forEach(function(model){
            var tr=document.createElement('tr'),pred=forecast&&forecast.horizons[horizon]&&forecast.horizons[horizon].models[model];
            var stat=statsMap[asset+'|'+horizon+'|'+model],n=stat?stat.decisive:0;
            decisiveTotal=Math.max(decisiveTotal,n);
            var accuracy=n>=30?Math.round(stat.wins/n*100)+'%':'Недостаточно данных';
            var mae=stat&&stat.n>0?(stat.mae/stat.n*100).toFixed(3)+'%':'—';
            var brier=stat&&n>0?(stat.brier/n).toFixed(3):'—';
            var direction=pred==null?'—':pred>forecast.currentPrice?'▲':pred<forecast.currentPrice?'▼':'—';
            [PT4_MODEL_NAMES[model],pred==null?'—':pt4FormatPrice(pred),direction,accuracy,String(n),mae,brier].forEach(function(v){var td=document.createElement('td');td.textContent=v;tr.appendChild(td);});
            tbody.appendChild(tr);
        });
        document.getElementById('pt4-sample-count').textContent=decisiveTotal+' проверок на модель';
    }

    // ── MESSAGE RELAY ────────────────────────────────────────────────
    if (IS_TOP) {
        window.addEventListener('message', function(e) {
            var msgType = e.data && e.data.type;
            if (msgType === 'POROBOT_SCAN') {
                pt4Predictive.lastIndicator = e.data.scan || null;
                var scanAsset = e.data.scan && (e.data.scan.wsAsset || e.data.scan.asset);
                if(scanAsset)pt4Predictive.indicators[String(scanAsset).toUpperCase()]={direction:e.data.scan.direction,timestamp:Date.now()};
                renderPredictivePanel();
            } else if (msgType === 'POROBOT_PREDICTIVE_INDICATOR') {
                pt4Predictive.indicators[String(e.data.asset||'').toUpperCase()]={direction:e.data.direction,timestamp:Number(e.data.timestamp)||Date.now()};
                renderPredictivePanel();
            } else if (msgType === 'POROBOT_PREDICTIVE_WARMUP') {
                pt4Predictive.warmup[e.data.asset]=e.data;
                pt4Predictive.lastAsset=e.data.asset;
                renderPredictivePanel();
            } else if (msgType === 'POROBOT_PREDICTIVE_ASSETS') {
                var assetSelect = document.getElementById('pt4-asset'), keepAsset = assetSelect && assetSelect.value;
                (e.data.assets || []).forEach(function(assetName){ if(!assetSelect || Array.from(assetSelect.options).some(function(o){return o.value===assetName;}))return; var option=document.createElement('option');option.value=assetName;option.textContent=assetName;assetSelect.appendChild(option); });
                if(assetSelect && keepAsset && Array.from(assetSelect.options).some(function(o){return o.value===keepAsset;}))assetSelect.value=keepAsset;
            } else if (msgType === 'POROBOT_PREDICTIVE_SIGNAL') {
                var ps = e.data.signal || {};
                appendLog('🧠 Predictive [' + (ps.asset || '?') + '] ' + (ps.direction || '—') + ' · ' + (ps.model || '') + ' · ' + Math.round((ps.confidence || 0) * 100) + '% · ' + (ps.horizonSeconds || 0) + 'с');
            } else if (msgType === 'POROBOT_PREDICTIVE_TRADE_REQUEST') {
                var pt = e.data.trade || {};
                appendLog('📨 Predictive: заявка отправлена [' + (pt.asset || '?') + '] ' + (pt.direction || '') + ' · 
            } else if (msgType === 'POROBOT_PREDICTIVE_EVENT') {
                handlePredictiveEvent(e.data);
            } else if (msgType === 'PT4_PREDICTIVE_READY') {
                restorePredictiveState();
            } else if (msgType === 'POROBOT_PREDICTIVE_UPDATE') {
                handlePredictiveForecast(e.data.forecast);
            } else if (msgType === 'POROBOT_LOG') {
                appendLog(e.data.message);
                try { chrome.runtime.sendMessage({ type: 'POROBOT_LOG', message: e.data.message }); } catch(_) {}
            } else if (msgType === 'POROBOT_STATS') {
                syncStatsFromExternal(e.data.stats);
                try { chrome.runtime.sendMessage({ type: 'POROBOT_STATS', stats: e.data.stats }); } catch(_) {}
            } else if (msgType === 'POROBOT_TRADE') {
                addTradeToJournal(e.data.trade);
                try { chrome.runtime.sendMessage({ type: 'POROBOT_TRADE', trade: e.data.trade }); } catch(_) {}
            } else if (msgType === 'POROBOT_SIGNAL') {
                showSignal(e.data.signal);
                try { chrome.runtime.sendMessage({ type: 'POROBOT_SIGNAL', signal: e.data.signal }); } catch(_) {}
            } else if (msgType === 'POROBOT_TRADE_RESULT') {
                autoRecordResult(e.data.result, e.data.profit, { nextBet: e.data.nextBet, mmStep: e.data.mmStep, mm: e.data.mm });
            } else if (msgType === 'POROBOT_MULTI_SIGNAL') {
                var ms = e.data.signal || {};
                appendLog('🔎 [' + (ms.asset || '?') + '] ' + (ms.direction || 'NEUTRAL') + ' | выплата ' + (ms.payout || 0) + '%');
            } else if (msgType === 'POROBOT_MULTI_TRADE_OPEN') {
                var mo = e.data.trade || {};
                appendLog('🤖 Открыта [' + (mo.asset || '?') + '] ' + (mo.direction || '') + ' | $' + (parseFloat(mo.amount) || 0).toFixed(2));
            } else if (msgType === 'POROBOT_MULTI_TRADE_RESULT') {
                var mt = e.data.trade || {};
                if (mt.result === 'WIN' || mt.result === 'LOSE') {
                    var mp = netPnlFromResult(mt.result, parseFloat(mt.profit) || 0, mt.amount);
                    var mtime = new Date();
                    var mts = String(mtime.getHours()).padStart(2,'0') + ':' + String(mtime.getMinutes()).padStart(2,'0') + ':' + String(mtime.getSeconds()).padStart(2,'0');
                    applySessionPnl(mt.result, mp);
                    updateStreak(mt.result);
                    addTradeToJournal({ time: mts, asset: mt.asset || '?', direction: mt.direction || '', bet: mt.amount || 0, result: mt.result, profit: mp.toFixed(2), strategy: 'Multi-pair · payout ' + (mt.payout || 0) + '%' });
                    renderAssetStats();
                    renderIndStats();
                    posTelemetryTrade({ asset: mt.asset, direction: mt.direction, amount: mt.amount }, mt.result, mp, 'multi_pair', true);
                    appendLog((mt.result === 'WIN' ? '✅' : '❌') + ' [' + mt.asset + '] ' + mt.result + ' | P&L: ' + (mp >= 0 ? '+' : '-') + '$' + Math.abs(mp).toFixed(2));
                    showTradeReaction(mt.result);
                    checkAutoTradeGuards();
                } else if (mt.result === 'DRAW') {
                    appendLog('➖ [' + (mt.asset || '?') + '] Возврат ставки');
                }
            } else if (msgType === 'POROBOT_SCAN') {
                updateLiveScan(e.data.scan);
            } else if (msgType === 'POROBOT_ASSET') {
                var assetEl = document.getElementById('pos-cur-asset');
                var liveDot = document.getElementById('pos-asset-live-dot');
                if (assetEl && e.data.asset) {
                    assetEl.textContent = e.data.asset;
                    if (liveDot) liveDot.classList.add('active');
                }
                if (e.data.asset && e.data.asset !== _posTelemAsset) {
                    _posTelemAsset = String(e.data.asset);
                    posTelemetryState();
                }
            } else if (msgType === 'POROBOT_BALANCE') {
                var bal = e.data.balance != null ? parseFloat(e.data.balance) : NaN;
                var demoBal = e.data.demoBalance != null ? parseFloat(e.data.demoBalance) : null;
                var realBal = e.data.realBalance != null ? parseFloat(e.data.realBalance) : null;
                if ((!isNaN(bal) && bal >= 0) ||
                    (demoBal != null && !isNaN(demoBal)) ||
                    (realBal != null && !isNaN(realBal))) {
                    syncAccountBalanceUI({
                        balance: !isNaN(bal) && bal >= 0 ? bal : null,
                        accountType: e.data.accountType,
                        demoBalance: demoBal != null && !isNaN(demoBal) ? demoBal : null,
                        realBalance: realBal != null && !isNaN(realBal) ? realBal : null,
                        source: e.data.source || null,
                        ts: e.data.ts || Date.now()
                    });
                }
            } else if (msgType === 'POROBOT_AUTO_STOP') {
                disableAutoTrade(
                    e.data.reason === 'tp' ? 'toast_take_profit'
                        : e.data.reason === 'tl' ? 'toast_take_loss'
                        : 'toast_low_balance',
                    e.data.reason === 'tp' ? 'ok' : 'err'
                );
            }
        });
    } else {
        window.addEventListener('message', function(e) {
            var msgType = e.data && e.data.type;
            if (msgType === 'POROBOT_LOG' || msgType === 'POROBOT_STATS' || msgType === 'POROBOT_TRADE' || msgType === 'POROBOT_SIGNAL' || msgType === 'POROBOT_TRADE_RESULT' || msgType === 'POROBOT_MULTI_SIGNAL' || msgType === 'POROBOT_MULTI_TRADE_OPEN' || msgType === 'POROBOT_MULTI_TRADE_RESULT' || msgType === 'POROBOT_ASSET' || msgType === 'POROBOT_SCAN' || msgType === 'POROBOT_BALANCE' || msgType === 'POROBOT_AUTO_STOP') {
                try { window.top.postMessage(e.data, '*'); } catch(_) {}
            }
        });
    }

    // ── EXTENSION COMMANDS ───────────────────────────────────────────
    try {
        chrome.runtime.onMessage.addListener(function(request) {
            function relayCoreCmd(req) {
                try { window.postMessage({ type: 'POROBOT_CORE_CMD', cmd: req.cmd, config: req.config, patch: req.patch, enabled: req.enabled }, '*'); } catch(_) {}
            }
            // Windows-приложение выключило бота (bridge/bridge-client.js): останавливаем
            // автоторговлю и убираем оверлей. На pocketoption.com не приходит — там статические скрипты.
            if (request.type === 'POS_BRIDGE_OFF') {
                relayCoreCmd({ cmd: 'STOP' });
                var bridgePanel = IS_TOP && document.getElementById('pos-panel');
                if (bridgePanel) bridgePanel.remove();
                return;
            }
            if (!IS_TOP) {
                var hasTrade = !!document.querySelector('.block--expiration-inputs, a.btn.btn-call, a.btn.btn-put, .btn.btn-call, .btn.btn-put, .btn-call, .btn-put, .dops__timeframes-item, .value__val input, .control__value input');
                if (request.type === 'POROBOT_CORE_CMD') {
                    if (hasTrade || (request.patch && (request.patch.expiration != null || request.patch.baseBet != null))) relayCoreCmd(request);
                } else if (request.type === 'POROBOT_START') {
                    if (hasTrade) relayCoreCmd({ cmd: 'START', config: request.config });
                } else if (request.type === 'POROBOT_STOP') {
                    relayCoreCmd({ cmd: 'STOP' });
                }
                return;
            }
            if (request.type === 'POROBOT_CORE_CMD') {
                relayCoreCmd(request);
            } else if (request.type === 'POROBOT_START') {
                relayCoreCmd({ cmd: 'START', config: request.config });
            } else if (request.type === 'POROBOT_STOP') {
                relayCoreCmd({ cmd: 'STOP' });
            } else if (request.type === 'POROBOT_LOG') {
                appendLog(request.message);
            } else if (request.type === 'POROBOT_STATS') {
                syncStatsFromExternal(request.stats);
            } else if (request.type === 'POROBOT_TRADE') {
                addTradeToJournal(request.trade);
            } else if (request.type === 'POROBOT_SIGNAL') {
                showSignal(request.signal);
            }
        });
    } catch(_) {}

    // ── BOT_TICK ─────────────────────────────────────────────────────
    window.addEventListener('BOT_TICK', function(e) {
        var asset = e.detail && e.detail.asset;
        if (!asset || asset === 'UNKNOWN') return;
        var el = document.getElementById('pos-cur-asset');
        if (el) el.textContent = asset;
    });

    // ── INIT ─────────────────────────────────────────────────────────
    if (IS_TOP) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', injectBotUI);
        } else {
            injectBotUI();
        }
    }

})();
 + (Number(pt.amount) || 0).toFixed(2));
            } else if (msgType === 'POROBOT_PREDICTIVE_EVENT') {
                handlePredictiveEvent(e.data);
            } else if (msgType === 'PT4_PREDICTIVE_READY') {
                restorePredictiveState();
            } else if (msgType === 'POROBOT_PREDICTIVE_UPDATE') {
                handlePredictiveForecast(e.data.forecast);
            } else if (msgType === 'POROBOT_LOG') {
                appendLog(e.data.message);
                try { chrome.runtime.sendMessage({ type: 'POROBOT_LOG', message: e.data.message }); } catch(_) {}
            } else if (msgType === 'POROBOT_STATS') {
                syncStatsFromExternal(e.data.stats);
                try { chrome.runtime.sendMessage({ type: 'POROBOT_STATS', stats: e.data.stats }); } catch(_) {}
            } else if (msgType === 'POROBOT_TRADE') {
                addTradeToJournal(e.data.trade);
                try { chrome.runtime.sendMessage({ type: 'POROBOT_TRADE', trade: e.data.trade }); } catch(_) {}
            } else if (msgType === 'POROBOT_SIGNAL') {
                showSignal(e.data.signal);
                try { chrome.runtime.sendMessage({ type: 'POROBOT_SIGNAL', signal: e.data.signal }); } catch(_) {}
            } else if (msgType === 'POROBOT_TRADE_RESULT') {
                autoRecordResult(e.data.result, e.data.profit, { nextBet: e.data.nextBet, mmStep: e.data.mmStep, mm: e.data.mm });
            } else if (msgType === 'POROBOT_MULTI_SIGNAL') {
                var ms = e.data.signal || {};
                appendLog('🔎 [' + (ms.asset || '?') + '] ' + (ms.direction || 'NEUTRAL') + ' | выплата ' + (ms.payout || 0) + '%');
            } else if (msgType === 'POROBOT_MULTI_TRADE_OPEN') {
                var mo = e.data.trade || {};
                appendLog('🤖 Открыта [' + (mo.asset || '?') + '] ' + (mo.direction || '') + ' | $' + (parseFloat(mo.amount) || 0).toFixed(2));
            } else if (msgType === 'POROBOT_MULTI_TRADE_RESULT') {
                var mt = e.data.trade || {};
                if (mt.result === 'WIN' || mt.result === 'LOSE') {
                    var mp = netPnlFromResult(mt.result, parseFloat(mt.profit) || 0, mt.amount);
                    var mtime = new Date();
                    var mts = String(mtime.getHours()).padStart(2,'0') + ':' + String(mtime.getMinutes()).padStart(2,'0') + ':' + String(mtime.getSeconds()).padStart(2,'0');
                    applySessionPnl(mt.result, mp);
                    updateStreak(mt.result);
                    addTradeToJournal({ time: mts, asset: mt.asset || '?', direction: mt.direction || '', bet: mt.amount || 0, result: mt.result, profit: mp.toFixed(2), strategy: 'Multi-pair · payout ' + (mt.payout || 0) + '%' });
                    renderAssetStats();
                    renderIndStats();
                    posTelemetryTrade({ asset: mt.asset, direction: mt.direction, amount: mt.amount }, mt.result, mp, 'multi_pair', true);
                    appendLog((mt.result === 'WIN' ? '✅' : '❌') + ' [' + mt.asset + '] ' + mt.result + ' | P&L: ' + (mp >= 0 ? '+' : '-') + '$' + Math.abs(mp).toFixed(2));
                    showTradeReaction(mt.result);
                    checkAutoTradeGuards();
                } else if (mt.result === 'DRAW') {
                    appendLog('➖ [' + (mt.asset || '?') + '] Возврат ставки');
                }
            } else if (msgType === 'POROBOT_SCAN') {
                updateLiveScan(e.data.scan);
            } else if (msgType === 'POROBOT_ASSET') {
                var assetEl = document.getElementById('pos-cur-asset');
                var liveDot = document.getElementById('pos-asset-live-dot');
                if (assetEl && e.data.asset) {
                    assetEl.textContent = e.data.asset;
                    if (liveDot) liveDot.classList.add('active');
                }
                if (e.data.asset && e.data.asset !== _posTelemAsset) {
                    _posTelemAsset = String(e.data.asset);
                    posTelemetryState();
                }
            } else if (msgType === 'POROBOT_BALANCE') {
                var bal = e.data.balance != null ? parseFloat(e.data.balance) : NaN;
                var demoBal = e.data.demoBalance != null ? parseFloat(e.data.demoBalance) : null;
                var realBal = e.data.realBalance != null ? parseFloat(e.data.realBalance) : null;
                if ((!isNaN(bal) && bal >= 0) ||
                    (demoBal != null && !isNaN(demoBal)) ||
                    (realBal != null && !isNaN(realBal))) {
                    syncAccountBalanceUI({
                        balance: !isNaN(bal) && bal >= 0 ? bal : null,
                        accountType: e.data.accountType,
                        demoBalance: demoBal != null && !isNaN(demoBal) ? demoBal : null,
                        realBalance: realBal != null && !isNaN(realBal) ? realBal : null,
                        source: e.data.source || null,
                        ts: e.data.ts || Date.now()
                    });
                }
            } else if (msgType === 'POROBOT_AUTO_STOP') {
                disableAutoTrade(
                    e.data.reason === 'tp' ? 'toast_take_profit'
                        : e.data.reason === 'tl' ? 'toast_take_loss'
                        : 'toast_low_balance',
                    e.data.reason === 'tp' ? 'ok' : 'err'
                );
            }
        });
    } else {
        window.addEventListener('message', function(e) {
            var msgType = e.data && e.data.type;
            if (msgType === 'POROBOT_LOG' || msgType === 'POROBOT_STATS' || msgType === 'POROBOT_TRADE' || msgType === 'POROBOT_SIGNAL' || msgType === 'POROBOT_TRADE_RESULT' || msgType === 'POROBOT_MULTI_SIGNAL' || msgType === 'POROBOT_MULTI_TRADE_OPEN' || msgType === 'POROBOT_MULTI_TRADE_RESULT' || msgType === 'POROBOT_ASSET' || msgType === 'POROBOT_SCAN' || msgType === 'POROBOT_BALANCE' || msgType === 'POROBOT_AUTO_STOP') {
                try { window.top.postMessage(e.data, '*'); } catch(_) {}
            }
        });
    }

    // ── EXTENSION COMMANDS ───────────────────────────────────────────
    try {
        chrome.runtime.onMessage.addListener(function(request) {
            function relayCoreCmd(req) {
                try { window.postMessage({ type: 'POROBOT_CORE_CMD', cmd: req.cmd, config: req.config, patch: req.patch, enabled: req.enabled }, '*'); } catch(_) {}
            }
            // Windows-приложение выключило бота (bridge/bridge-client.js): останавливаем
            // автоторговлю и убираем оверлей. На pocketoption.com не приходит — там статические скрипты.
            if (request.type === 'POS_BRIDGE_OFF') {
                relayCoreCmd({ cmd: 'STOP' });
                var bridgePanel = IS_TOP && document.getElementById('pos-panel');
                if (bridgePanel) bridgePanel.remove();
                return;
            }
            if (!IS_TOP) {
                var hasTrade = !!document.querySelector('.block--expiration-inputs, a.btn.btn-call, a.btn.btn-put, .btn.btn-call, .btn.btn-put, .btn-call, .btn-put, .dops__timeframes-item, .value__val input, .control__value input');
                if (request.type === 'POROBOT_CORE_CMD') {
                    if (hasTrade || (request.patch && (request.patch.expiration != null || request.patch.baseBet != null))) relayCoreCmd(request);
                } else if (request.type === 'POROBOT_START') {
                    if (hasTrade) relayCoreCmd({ cmd: 'START', config: request.config });
                } else if (request.type === 'POROBOT_STOP') {
                    relayCoreCmd({ cmd: 'STOP' });
                }
                return;
            }
            if (request.type === 'POROBOT_CORE_CMD') {
                relayCoreCmd(request);
            } else if (request.type === 'POROBOT_START') {
                relayCoreCmd({ cmd: 'START', config: request.config });
            } else if (request.type === 'POROBOT_STOP') {
                relayCoreCmd({ cmd: 'STOP' });
            } else if (request.type === 'POROBOT_LOG') {
                appendLog(request.message);
            } else if (request.type === 'POROBOT_STATS') {
                syncStatsFromExternal(request.stats);
            } else if (request.type === 'POROBOT_TRADE') {
                addTradeToJournal(request.trade);
            } else if (request.type === 'POROBOT_SIGNAL') {
                showSignal(request.signal);
            }
        });
    } catch(_) {}

    // ── BOT_TICK ─────────────────────────────────────────────────────
    window.addEventListener('BOT_TICK', function(e) {
        var asset = e.detail && e.detail.asset;
        if (!asset || asset === 'UNKNOWN') return;
        var el = document.getElementById('pos-cur-asset');
        if (el) el.textContent = asset;
    });

    // ── INIT ─────────────────────────────────────────────────────────
    if (IS_TOP) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', injectBotUI);
        } else {
            injectBotUI();
        }
    }

})();
