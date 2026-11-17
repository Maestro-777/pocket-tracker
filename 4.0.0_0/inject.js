// inject.js - PocketOption Signal v3.6.0
// Platform: Pocket Option (pocketoption.com)
// Site: pocketoption-signal.online
// Внедряется в MAIN-world страницы Pocket Option (pocketoption.com)

(function() {
    'use strict';

    if (window.__PocketOptionSignalInjected) return;
    window.__PocketOptionSignalInjected = true;

    console.log('[PocketOption Signal] inject.js - WebSocket interceptor active.');

    const OriginalWebSocket = window.WebSocket;

    // ── PocketOption binary decoder: UTF-8 JSON inside ArrayBuffer ──
    // (NOT msgpack - PocketOption encodes JSON as binary UTF-8 bytes)
    function decodePOBinary(ab) {
        const bytes = new Uint8Array(ab instanceof ArrayBuffer ? ab : ab.buffer);
        const text = new TextDecoder('utf-8').decode(bytes);
        try { return JSON.parse(text); } catch(e) { return text; }
    }

    // ── Read UID from PocketOption's AppData in <script> tags ───────
    function readUIDFromPage() {
        try {
            const scripts = document.getElementsByTagName('script');
            for (let i = 0; i < scripts.length; i++) {
                const src = scripts[i].innerHTML;
                if (src.indexOf('AppData') !== -1) {
                    const m = src.match(/\{.*\}/);
                    if (m) {
                        const data = JSON.parse(m[0]);
                        if (data && data.uid) return parseInt(data.uid);
                    }
                }
            }
        } catch(e) {}
        return null;
    }

    // ── Алиасы DOM ↔ WebSocket (Pocket Option) ────────────────────────────
    const PO_ASSET_ALIASES = {
        // Crypto
        AVALANCHE: 'AVAX', AVAX: 'AVALANCHE',
        SOLANA: 'SOLUSD', SOLUSD: 'SOLANA', SOL: 'SOLUSD',
        BITCOIN: 'BTCUSD', BTCUSD: 'BITCOIN', BTC: 'BTCUSD',
        ETHEREUM: 'ETHUSD', ETHUSD: 'ETHEREUM', ETH: 'ETHUSD',
        RIPPLE: 'XRPUSD', XRPUSD: 'RIPPLE', XRP: 'XRPUSD',
        DOGECOIN: 'DOGEUSD', DOGEUSD: 'DOGECOIN', DOGE: 'DOGEUSD',
        CARDANO: 'ADAUSD', ADAUSD: 'CARDANO', ADA: 'ADAUSD',
        POLKADOT: 'DOTUSD', DOTUSD: 'POLKADOT', DOT: 'DOTUSD',
        LITECOIN: 'LTCUSD', LTCUSD: 'LITECOIN', LTC: 'LTCUSD',
        CHAINLINK: 'LINKUSD', LINKUSD: 'CHAINLINK', LINK: 'LINKUSD',
        POLYGON: 'MATICUSD', MATICUSD: 'POLYGON', MATIC: 'MATICUSD',
        BINANCE: 'BNBUSD', BNBUSD: 'BINANCE', BNB: 'BNBUSD',
        TRON: 'TRXUSD', TRXUSD: 'TRON', TRX: 'TRXUSD',
        SHIBA: 'SHIBUSD', SHIBUSD: 'SHIBA', SHIB: 'SHIBUSD',
        NEAR: 'NEARUSD', NEARUSD: 'NEAR',
        UNISWAP: 'UNIUSD', UNIUSD: 'UNISWAP', UNI: 'UNIUSD',
        COSMOS: 'ATOMUSD', ATOMUSD: 'COSMOS', ATOM: 'ATOMUSD',
        MONERO: 'XMRUSD', XMRUSD: 'MONERO', XMR: 'XMRUSD',
        STELLAR: 'XLMUSD', XLMUSD: 'STELLAR', XLM: 'XLMUSD',
        ALGORAND: 'ALGOUSD', ALGOUSD: 'ALGORAND', ALGO: 'ALGOUSD',
        FILECOIN: 'FILUSD', FILUSD: 'FILECOIN', FIL: 'FILUSD',
        APTOS: 'APTUSD', APTUSD: 'APTOS', APT: 'APTUSD',
        ARBITRUM: 'ARBUSD', ARBUSD: 'ARBITRUM', ARB: 'ARBUSD',
        OPTIMISM: 'OPUSD', OPUSD: 'OPTIMISM',
        PEPE: 'PEPEUSD', PEPEUSD: 'PEPE',
        TONCOIN: 'TONUSD', TONUSD: 'TONCOIN', TON: 'TONUSD',
        // Commodities (DOM friendly name ↔ WS ticker)
        GOLD: 'XAUUSD', XAUUSD: 'GOLD',
        SILVER: 'XAGUSD', XAGUSD: 'SILVER',
        PLATINUM: 'XPTUSD', XPTUSD: 'PLATINUM', PLATINUMSPOT: 'XPTUSD',
        PALLADIUM: 'XPDUSD', XPDUSD: 'PALLADIUM', PALLADIUMSPOT: 'XPDUSD',
        BRENTOIL: 'UKBRENT', UKBRENT: 'BRENTOIL', BRENT: 'UKBRENT', BRENTCRUDE: 'UKBRENT',
        WTICRUDEOIL: 'USCRUDE', USCRUDE: 'WTICRUDEOIL', CRUDEOIL: 'USCRUDE', CRUDE: 'USCRUDE', WTI: 'USCRUDE',
        NATURALGAS: 'XNGUSD', XNGUSD: 'NATURALGAS', NATGAS: 'XNGUSD',
        // Indices (DOM label ↔ WS symbol)
        NASDAQ: 'NASUSD', NASUSD: 'NASDAQ', NASDAQ100: 'NASUSD', US100: 'NASUSD',
        US500: 'SP500', SANDP500: 'SP500', SANDP: 'SP500',
        DOWJONES: 'DJI30', DOW: 'DJI30',
        DAX: 'D30EUR', DAX40: 'D30EUR', GER40: 'D30EUR', GERMANY40: 'D30EUR',
        FTSE: '100GBP', FTSE100: '100GBP',
        EUROSTOXX50: 'E50EUR', EUROSTOXX35: 'E35EUR',
        NIKKEI: 'JPN225', NIKKEI225: 'JPN225',
        HANGSENG: 'H33HKD', ASX200: 'AUS200',
        // US stocks (DOM company name ↔ ticker)
        APPLE: 'AAPL', AAPL: 'APPLE',
        AMAZON: 'AMZN', AMZN: 'AMAZON',
        GOOGLE: 'GOOGL', GOOGL: 'GOOGLE', ALPHABET: 'GOOGL',
        MICROSOFT: 'MSFT', MSFT: 'MICROSOFT',
        TESLA: 'TSLA', TSLA: 'TESLA',
        FACEBOOK: 'META', FB: 'META',
        FACEBOOKINC: 'META', META: 'FACEBOOKINC',
        NVIDIA: 'NVDA', NVDA: 'NVIDIA',
        NETFLIX: 'NFLX', NFLX: 'NETFLIX',
        COINBASE: 'COIN', COIN: 'COINBASE',
        MCDONALDS: 'MCD', MCD: 'MCDONALDS', MCDONALD: 'MCD',
        BOEING: 'BA', BA: 'BOEING',
        INTEL: 'INTC', INTC: 'INTEL',
        CISCO: 'CSCO', CSCO: 'CISCO',
        JOHNSON: 'JNJ', JOHNSONANDJOHNSON: 'JNJ', JNJ: 'JOHNSON',
        PFIZER: 'PFE', PFE: 'PFIZER',
        EXXON: 'XOM', EXXONMOBIL: 'XOM', XOM: 'EXXON',
        AMERICANEXPRESS: 'AXP', AXP: 'AMERICANEXPRESS',
        CITIGROUP: 'CITI', CITI: 'CITIGROUP',
        COCACOLA: 'KO', KO: 'COCACOLA',
        ALIBABA: 'BABA', BABA: 'ALIBABA',
        FEDEX: 'FDX', FDX: 'FEDEX',
        JPMORGAN: 'JPM', JPM: 'JPMORGAN',
        WALMART: 'WMT', WMT: 'WALMART',
        DISNEY: 'DIS', DIS: 'DISNEY',
        TWITTER: 'TWTR', TWTR: 'TWITTER',
        VISA: 'V', V: 'VISA',
        AMERICAN_EXPRESS: 'AXP',
        // PO alternate tickers / symbol formats
        CHAINLINK: 'LNKUSD', LINKUSD: 'LNKUSD', LNKUSD: 'CHAINLINK', LINK: 'LNKUSD',
        DASH: 'DASH_USD', DASHUSD: 'DASH_USD',
        BITCOINCASH: 'BCHEUR', BCH: 'BCHEUR',
        POLKADOTUSD: 'DOTUSD',
        // Indices (extra labels)
        SPX: 'SP500', SPX500: 'SP500', SANDP500: 'SP500',
        DJIA: 'DJI30', DOWJONES30: 'DJI30',
        DAX30: 'D30EUR', GER30: 'D30EUR', GERMANY30: 'D30EUR',
        CAC: 'F40EUR', CAC40: 'F40EUR',
        FTSE100: '100GBP', UK100: '100GBP',
        NIKKEI225: 'JPN225', JPN225: 'NIKKEI225',
        HANGSENG: 'H33HKD', HSI: 'H33HKD',
        ASX200: 'AUS200', AUS200: 'ASX200',
        AEX: 'AEX25', SMI: 'SMI20',
    };
    const _learnedAliases = {};
    window.__poAssetCatalog = window.__poAssetCatalog || {};

    function normalizeCatalogLabel(raw) {
        if (!raw) return '';
        let s = raw.toString().trim().toUpperCase();
        s = s.replace(/^#/, '');
        const hasOtc = /\bOTC\b/i.test(s) || /_OTC$/i.test(s);
        s = s.replace(/\bOTC\b/gi, '').replace(/_OTC$/gi, '');
        s = s.replace(/\s+/g, '').replace(/[^A-Z0-9_]/g, '');
        s = s.replace(/_/g, '');
        if (hasOtc && s && !s.endsWith('_OTC')) s += '_OTC';
        return normalizeAssetName(s);
    }

    function isFxCurrencyPair(symbol) {
        const raw = String(symbol || '').toUpperCase().replace(/_?OTC$/i, '').replace(/[^A-Z]/g, '');
        if (raw.length !== 6) return false;
        const currencies = new Set(['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD','CNY','HKD','SGD','TRY','ZAR','MXN','NOK','SEK','PLN','THB','INR','IDR','BRL','KRW','CZK','HUF','ILS','DKK','AED','RUB','UZS','KZT','PHP','MYR','SAR','QAR','KWD','BHD','OMR','EGP','PKR','BDT','VND','TWD','COP','CLP','PEN','ARS','UYU','NGN','KES','GHS','MAD','UAH','RON','BGN','RSD','HRK','ISK','GEL','AZN','AMD','ALL','MKD','MDL','BYN','XOF','XAF','XCD','JOD','LBP','LKR','NPR','MUR','BWP','NAD','UGX','TZS','ZMW']);
        return currencies.has(raw.slice(0, 3)) && currencies.has(raw.slice(3, 6));
    }

    function ingestAssetsCatalog(payload) {
        const rows = Array.isArray(payload) ? payload : (payload && payload.assets ? payload.assets : [payload]);
        if (!rows || !rows.length) return 0;
        let learned = 0;
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row) continue;
            let symbol = '', label = '', profit = NaN, active = false;
            if (Array.isArray(row) && row.length >= 2) {
                symbol = row[1];
                label = row[2] || row[1];
                profit = parseFloat(row[5]);
                active = !!row[14]; // Same truthy active flag used by 1.1.7_0.
            } else if (typeof row === 'object') {
                symbol = row.symbol || row.asset || row.code || row.s || '';
                label = row.name || row.title || row.label || row.n || symbol;
                profit = parseFloat(row.profit ?? row.payout ?? row.percentProfit);
                const activeValue = row.active ?? row.isActive ?? row.enabled ?? row.tradable;
                active = activeValue === true || activeValue === 1 || activeValue === '1' || String(activeValue).toLowerCase() === 'true';
            }
            if (!symbol) continue;
            rememberRawAsset(symbol);
            const symNorm = normalizeAssetName(symbol);
            const labelNorm = normalizeCatalogLabel(label);
            if (!symNorm) continue;
            window.__poAssetCatalog[symNorm] = {
                symbol: symNorm,
                label: labelNorm || symNorm,
                raw: symbol,
                profit: isFinite(profit) ? (profit > 0 && profit <= 1 ? profit * 100 : profit) : NaN,
                active: active
            };
            if (labelNorm && !assetsMatch(labelNorm, symNorm)) {
                learnAssetAlias(labelNorm, symNorm);
                learned++;
            }
            // Символ без # ↔ с # (акции PO: #AAPL ↔ AAPL)
            const symBase = assetBase(symNorm);
            if (symBase && /^[A-Z]{1,5}$/.test(symBase)) {
                const hashNorm = normalizeAssetName('#' + symBase);
                if (hashNorm !== symNorm) learnAssetAlias(hashNorm, symNorm);
            }
        }
        if (learned && !window._poCatalogLogged) {
            window._poCatalogLogged = true;
            const core = window.__poCore;
            if (core && core.log) {
                core.log('📚 Каталог PO: ' + Object.keys(window.__poAssetCatalog).length + ' инструментов, ' + learned + ' алиасов');
            }
            console.log('[PocketOption Signal] Asset catalog ingested:', Object.keys(window.__poAssetCatalog).length, 'symbols,', learned, 'aliases learned');
        }
        return learned;
    }

    function learnAssetAlias(a, b) {
        const ba = assetBase(a), bb = assetBase(b);
        if (!ba || !bb || ba === bb) return;
        _learnedAliases[ba] = bb;
        _learnedAliases[bb] = ba;
        registerAssetAliasNorms(a, b);
    }

    function registerAssetAliasNorms(a, b) {
        if (!window.__poRawAssetByNorm) window.__poRawAssetByNorm = {};
        const na = normalizeAssetName(a);
        const nb = normalizeAssetName(b);
        const rawA = window.__poRawAssetByNorm[na];
        const rawB = window.__poRawAssetByNorm[nb];
        if (rawA && !window.__poRawAssetByNorm[nb]) window.__poRawAssetByNorm[nb] = rawA;
        if (rawB && !window.__poRawAssetByNorm[na]) window.__poRawAssetByNorm[na] = rawB;
        const ba = assetBase(na), bb = assetBase(nb);
        allEquivalentBases(ba).forEach(function(eq) {
            const alt = withOtcSuffix(eq, na);
            if (rawA && !window.__poRawAssetByNorm[alt]) window.__poRawAssetByNorm[alt] = rawA;
            if (rawB && !window.__poRawAssetByNorm[alt]) window.__poRawAssetByNorm[alt] = rawB;
        });
        allEquivalentBases(bb).forEach(function(eq) {
            const alt = withOtcSuffix(eq, nb);
            if (rawA && !window.__poRawAssetByNorm[alt]) window.__poRawAssetByNorm[alt] = rawA;
            if (rawB && !window.__poRawAssetByNorm[alt]) window.__poRawAssetByNorm[alt] = rawB;
        });
    }

    function aliasBase(base) {
        if (!base) return base;
        return PO_ASSET_ALIASES[base] || _learnedAliases[base] || base;
    }

    function aliasTargets(base) {
        const out = [];
        if (!base) return out;
        if (PO_ASSET_ALIASES[base]) out.push(PO_ASSET_ALIASES[base]);
        if (_learnedAliases[base]) out.push(_learnedAliases[base]);
        return out;
    }

    // Полный компонент связности: алиасы должны быть симметричны
    // (BNB → BNBUSD → BINANCE и обратно), иначе DOM BNB_OTC не матчит WS BNBUSD_OTC.
    function allEquivalentBases(base) {
        const set = new Set([base]);
        const queue = [base];
        while (queue.length) {
            const cur = queue.pop();
            const candidates = aliasTargets(cur);
            Object.keys(PO_ASSET_ALIASES).forEach(function(k) {
                if (PO_ASSET_ALIASES[k] === cur) candidates.push(k);
            });
            Object.keys(_learnedAliases).forEach(function(k) {
                if (_learnedAliases[k] === cur) candidates.push(k);
            });
            for (let i = 0; i < candidates.length; i++) {
                const mapped = candidates[i];
                if (mapped && !set.has(mapped)) {
                    set.add(mapped);
                    queue.push(mapped);
                }
            }
        }
        return set;
    }

    function assetBasesEquivalent(a, b) {
        if (!a || !b) return false;
        if (a === b) return true;
        const eq = allEquivalentBases(a);
        if (eq.has(b)) return true;
        return allEquivalentBases(b).has(a);
    }

    // ── Нормализация названия актива (EUR/USD OTC → EURUSD_OTC) ───────────
    function normalizeAssetName(raw) {
        if (!raw) return '';
        let s = raw.toString().trim().toUpperCase();
        const hasOtc = /\bOTC\b/i.test(s) || /_OTC$/i.test(s);
        s = s.replace(/\bOTC\b/gi, '').replace(/_OTC$/gi, '').replace(/\s+/g, '').replace(/[^A-Z0-9_]/g, '');
        if (hasOtc && s && !s.endsWith('_OTC')) s += '_OTC';
        return s;
    }

    function looksLikeAsset(name) {
        if (!name || name.length < 3) return false;
        const base = assetBase(name);
        const junk = /^(CALL|PUT|BUY|SELL|DEMO|REAL|POCKET|SIGNAL|START|STOP|M\d|S\d|\d+)$/;
        if (junk.test(base) || junk.test(name)) return false;
        return base.length >= 4 || /_OTC$/i.test(name);
    }

    function assetBase(name) {
        return normalizeAssetName(name).replace(/_OTC$/i, '');
    }

    function assetBaseVariants(base) {
        if (!base) return [base];
        const set = new Set([base]);
        const stripped = base.replace(/(INCORPORATED|INC|CORP|LTD|LIMITED|CO)$/i, '');
        if (stripped && stripped !== base) set.add(stripped);
        return Array.from(set);
    }

    function assetsMatch(a, b) {
        if (!a || !b) return false;
        const na = normalizeAssetName(a);
        const nb = normalizeAssetName(b);
        if (na === nb) return true;
        const ba = assetBase(na), bb = assetBase(nb);
        if (ba === bb) return true;
        const baVars = assetBaseVariants(ba);
        const bbVars = assetBaseVariants(bb);
        for (let i = 0; i < baVars.length; i++) {
            for (let j = 0; j < bbVars.length; j++) {
                if (baVars[i] === bbVars[j]) return true;
                if (assetBasesEquivalent(baVars[i], bbVars[j])) return true;
            }
        }
        return assetBasesEquivalent(ba, bb);
    }

    function expectedWsHints(domAsset) {
        const domBase = assetBase(normalizeAssetName(domAsset));
        const out = new Set();
        assetBaseVariants(domBase).forEach(function(b) {
            out.add(b);
            allEquivalentBases(b).forEach(function(e) { out.add(e); });
        });
        return Array.from(out).slice(0, 5);
    }

    function formatExpectedWs(domAsset) {
        return expectedWsHints(domAsset).map(function(h) {
            return h + (domAsset && domAsset.indexOf('_OTC') >= 0 ? '_OTC' : '');
        }).join(' / ');
    }

    function withOtcSuffix(base, refAsset) {
        const otc = /\bOTC\b|_OTC$/i.test(refAsset || '') || (refAsset || '').endsWith('_OTC');
        const norm = normalizeAssetName(base);
        if (otc && norm && !norm.endsWith('_OTC')) return norm + '_OTC';
        return norm;
    }

    function resolveWsAssetForDom(domAsset, priceKeys) {
        if (!domAsset) return null;
        const domNorm = normalizeAssetName(domAsset);
        const domBase = assetBase(domNorm);
        const keys = priceKeys || [];
        const targetBases = new Set();
        assetBaseVariants(domBase).forEach(function(b) {
            targetBases.add(b);
            allEquivalentBases(b).forEach(function(e) { targetBases.add(e); });
        });

        for (const k of keys) {
            if (assetsMatch(k, domNorm)) return k;
        }
        for (const k of keys) {
            const kb = assetBase(k);
            if (targetBases.has(kb)) return k;
            for (const tb of targetBases) {
                if (assetBasesEquivalent(kb, tb)) return k;
            }
        }
        for (const k of keys) {
            const kb = assetBase(k);
            if (domBase.length >= 4 && kb.length >= 4 && domBase.slice(0, 4) === kb.slice(0, 4)) return k;
        }
        return null;
    }

    function getFrameDepth() {
        try {
            let depth = 0, w = window;
            while (w !== w.top) { depth++; w = w.parent; }
            return depth;
        } catch (_) { return 0; }
    }

    function claimPrimaryEngine() {
        if (!shouldRunSignalEngine()) return false;
        try {
            const top = window.top;
            if (!top.__poEngineClaim) top.__poEngineClaim = { depth: -1, win: null };
            const claim = top.__poEngineClaim;
            const myDepth = getFrameDepth();
            if (!claim.win || myDepth >= claim.depth) {
                claim.depth = myDepth;
                claim.win = window;
            }
            return claim.win === window;
        } catch (_) {
            return shouldRunSignalEngine();
        }
    }

    function isPrimarySignalFrame() {
        if (!shouldRunSignalEngine()) return false;
        try {
            return window.top.__poEngineClaim && window.top.__poEngineClaim.win === window;
        } catch (_) {
            return shouldRunSignalEngine();
        }
    }

    function releasePrimaryEngine() {
        try {
            const top = window.top;
            if (top.__poEngineClaim && top.__poEngineClaim.win === window) {
                top.__poEngineClaim = null;
            }
        } catch (_) {}
    }

    function extractAssetFromElement(el) {
        if (!el) return '';
        const data = el.getAttribute && (el.getAttribute('data-asset') || el.getAttribute('data-symbol') || el.getAttribute('data-pair'));
        if (data) {
            const n = normalizeAssetName(data);
            if (looksLikeAsset(n)) return n;
        }
        let txt = (el.textContent || '').trim();
        txt = txt.split(/\n/)[0].trim();
        txt = txt.replace(/\s*\(?\s*OTC\s*\)?\s*$/i, ' OTC');
        const n = normalizeAssetName(txt);
        if (looksLikeAsset(n)) return n;
        return '';
    }

    function isVisible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    // ── Читаем текущий актив из DOM Pocket Option ──────────────────────────
    function readCurrentAssetFromDOM() {
        try {
            // Активная пара в списке инструментов
            const activeItem = document.querySelector(
                '.assets-block__item--active, .assets-block__item.active, ' +
                '[class*="asset-item"].active, [class*="asset-item--active"], ' +
                '.pairs-list__item.active, .pairs-list__item--active'
            );
            if (activeItem) {
                const a = extractAssetFromElement(activeItem);
                if (a) return a;
            }

            const selectors = [
                '.current-symbol',
                '.pair-number-wrap .pair',
                '.block__title-pair',
                '[class*="current-pair"]',
                '[class*="currentPair"]',
                '[class*="symbol-name"]',
                '[class*="symbolName"]',
                '[class*="asset-name"]',
                '[class*="assetName"]',
                '[class*="pair-name"]',
                '[class*="pairName"]',
                '.a-symbol__name',
                '.chart-symbol',
                '[class*="instrument-name"]',
                '[class*="current-asset"]',
            ];
            for (const sel of selectors) {
                const els = document.querySelectorAll(sel);
                for (const el of els) {
                    if (!isVisible(el)) continue;
                    const a = extractAssetFromElement(el);
                    if (a) return a;
                }
            }

            // data-asset на видимых элементах
            const dataEls = document.querySelectorAll('[data-asset], [data-symbol], [data-pair]');
            for (const el of dataEls) {
                if (!isVisible(el)) continue;
                const a = extractAssetFromElement(el);
                if (a) return a;
            }
        } catch(_) {}
        return 'UNKNOWN';
    }

    // ── WebSocket перехват ───────────────────────────────────────────
    // Get native onmessage descriptor from prototype (needed to set native handler)
    const _nativeOnMsgDesc = Object.getOwnPropertyDescriptor(OriginalWebSocket.prototype, 'onmessage');

    window.WebSocket = function(url, protocols) {
        const ws = protocols ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
        const wsUrl = String(url || '');
        const isPoMarketSocket = /\.po\.market(?:[/:?#]|$)/i.test(wsUrl);
        let wsRecord = null;
        if (isPoMarketSocket) {
            const records = window.__po_wsConnections || (window.__po_wsConnections = []);
            wsRecord = { ws: ws, url: wsUrl, lastDataAt: 0 };
            records.push(wsRecord);
            if (!window.__po_ws || window.__po_ws.readyState !== 1) {
                window.__po_ws = ws;
                window.__po_wsUrl = wsUrl;
            }
        }

        // Перехват исходящих сообщений - учим raw-имена активов (BNBUSD_otc и т.п.)
        try {
            const origSend = ws.send.bind(ws);
            ws.send = function(data) {
                try {
                    if (typeof data === 'string') {
                        const m = data.match(/"asset"\s*:\s*"([^"]+)"/);
                        if (m && m[1]) rememberRawAsset(m[1]);
                        if (data.indexOf('indicator/') >= 0) {
                            if (!window.__poIndOutN) window.__poIndOutN = 0;
                            if (window.__poIndOutN++ < 10) {
                                console.log('[PocketOption Signal] OUT', data.substring(0, 280));
                            }
                        }
                    }
                } catch (_) {}
                return origSend(data);
            };
        } catch (_) {}

        // Set binaryType to arraybuffer
        ws.binaryType = 'arraybuffer';
        try {
            Object.defineProperty(ws, 'binaryType', {
                get: () => 'arraybuffer',
                set: (v) => { /* keep arraybuffer, ignore resets */ },
                configurable: true
            });
        } catch(e) {}

        // ── Core message handler ──────────────────────────────────────
        let pendingEventForSocket = null;
        function _onMsg(event) {
            try {
                if (!isPoMarketSocket) return;
                if (wsRecord) {
                    const now = Date.now();
                    wsRecord.lastDataAt = now;
                    const active = window.__po_ws;
                    const records = window.__po_wsConnections || [];
                    const activeRecord = records.find(function(r) { return r.ws === active; });
                    if (!active || active.readyState !== 1 || active === ws ||
                        !activeRecord || now - (activeRecord.lastDataAt || 0) > 3000) {
                        window.__po_ws = ws;
                        window.__po_wsUrl = wsUrl;
                    }
                }
                // RAW diagnostic - first 5 messages always, then every 50th
                if (!window._posRawCount) window._posRawCount = 0;
                window._posRawCount++;
                if (window._posRawCount <= 5 || window._posRawCount % 50 === 0) {
                    let d = event.data;
                    if (typeof d === 'string' && d.length > 200) d = d.substring(0, 200) + '…';
                    if (d instanceof ArrayBuffer) d = '[ArrayBuffer ' + d.byteLength + 'b]';
                    console.log('[PocketOption Signal] MSG#' + window._posRawCount, typeof event.data, d);
                }

                if (typeof event.data === 'string') {
                    const str = event.data;
                    const jsonStart = str.search(/[\[{]/);
                    if (jsonStart === -1) return;
                    try {
                        const parsed = JSON.parse(str.substring(jsonStart));
                        if (Array.isArray(parsed) && typeof parsed[0] === 'string') {
                            const eventName = parsed[0];
                            const payload   = parsed[1];
                            if (!window._posDebugTypes) window._posDebugTypes = new Set();
                            if (!window._posDebugTypes.has(eventName)) {
                                window._posDebugTypes.add(eventName);
                                console.log('[PocketOption Signal] NEW EVENT TYPE:', eventName, parsed.length > 1 ? JSON.stringify(parsed[1]).substring(0,100) : '');
                            }
                            if (payload && payload._placeholder === true) {
                                pendingEventForSocket = eventName;
                            } else if (payload !== undefined) {
                                handlePOEvent(eventName, payload);
                            }
                        }
                    } catch(e) {}
                    return;
                }

                // Binary: ArrayBuffer or Blob
                const processBinary = (buffer) => {
                    const pendingEvent = pendingEventForSocket || 'unknown';
                    pendingEventForSocket = null;
                    let parsed;
                    try { parsed = decodePOBinary(buffer); } catch(e) {
                        if (!window._posDecErr) window._posDecErr = 0;
                        if (window._posDecErr++ < 5) console.warn('[PocketOption Signal] msgpack err', pendingEvent, e.message);
                        return;
                    }
                    if (!window._posDecoded) window._posDecoded = {};
                    const isInd = String(pendingEvent || '').indexOf('indicator') >= 0;
                    if (isInd || !window._posDecoded[pendingEvent]) {
                        if (!isInd) window._posDecoded[pendingEvent] = true;
                        const dump = JSON.stringify(parsed);
                        console.log('[PocketOption Signal] DECODED', pendingEvent, isInd ? dump : dump.substring(0, 300));
                    }
                    handlePOEvent(pendingEvent, parsed);
                };

                if (event.data instanceof ArrayBuffer) {
                    processBinary(event.data);
                } else if (event.data instanceof Blob) {
                    event.data.arrayBuffer().then(processBinary).catch(() => {});
                }

            } catch(e) { console.error('[PocketOption Signal] WS handler error:', e); }
        }

        // 1) addEventListener - catches messages if Socket.IO uses dispatchEvent
        ws.addEventListener('message', _onMsg);
        if (wsRecord) {
            ws.addEventListener('close', function() {
                const records = window.__po_wsConnections || [];
                const index = records.indexOf(wsRecord);
                if (index >= 0) records.splice(index, 1);
                if (window.__po_ws === ws) {
                    const candidates = records.filter(function(r) {
                        return r.ws && r.ws.readyState === 1;
                    }).sort(function(a, b) {
                        return (b.lastDataAt || 0) - (a.lastDataAt || 0);
                    });
                    const next = candidates.length ? candidates[0] : null;
                    window.__po_ws = next ? next.ws : null;
                    window.__po_wsUrl = next ? next.url : '';
                }
            });
        }

        // 2) Intercept onmessage setter - catches messages if Socket.IO sets ws.onmessage directly
        let _origOnMessage = null;
        try {
            Object.defineProperty(ws, 'onmessage', {
                get: () => _origOnMessage,
                set: (fn) => {
                    _origOnMessage = fn;
                    // Set native handler as a wrapper that calls BOTH our handler and original
                    if (_nativeOnMsgDesc && _nativeOnMsgDesc.set) {
                        _nativeOnMsgDesc.set.call(ws, function(ev) {
                            _onMsg(ev);
                            if (typeof fn === 'function') fn.call(ws, ev);
                        });
                    }
                },
                configurable: true
            });
        } catch(e) {}


        // ── Event-specific handlers ──────────────────────────────────
        function handlePOEvent(eventName, payload) {
            if (payload === null || payload === undefined) {
                console.log('[PocketOption Signal] handlePOEvent: no payload for', eventName);
                return;
            }

            // ── user_ready / successauth: store UID + balance ──
            if (eventName === 'user_ready' || eventName === 'successauth') {
                const src = Array.isArray(payload) ? payload[0] : payload;
                let uid = src && (src.uid || src.id);
                if (!uid) uid = readUIDFromPage();
                if (uid) {
                    window._poRobotUID = parseInt(uid);
                    window.postMessage({ type: 'POROBOT_UID_DETECTED', uid: parseInt(uid) }, '*');
                }
                const bal = src && parseFloat(src.balance ?? src.demo_balance ?? src.real_balance ?? src.amount ?? NaN);
                const isDemo = src && (src.is_demo ?? src.isDemo ?? src.demo_account ?? src.isDemoAccount);
                const accountType = isDemo === true || isDemo === 1 || isDemo === '1' ? 'demo'
                    : (isDemo === false || isDemo === 0 || isDemo === '0' ? 'real' : null);
                if (!isNaN(bal) && bal >= 0) {
                    window._poLastWsBalance = bal;
                    window._poLastWsAccountType = accountType;
                    try {
                        if (typeof postBalanceUpdate === 'function') postBalanceUpdate(true);
                        else {
                            window.postMessage({
                                type: 'POROBOT_BALANCE',
                                balance: bal,
                                accountType: accountType
                            }, '*');
                        }
                    } catch (_) {}
                }
                return;
            }

            if (eventName === 'updateAssets') {
                ingestAssetsCatalog(payload);
                const catalogCore = window.__poCore;
                if (catalogCore && catalogCore.isRunning && catalogCore.config?.multiPairTrading) {
                    catalogCore._refreshMultiPairs(true);
                }
                return;
            }

            if (eventName === 'updateCharts') {
                const rows = Array.isArray(payload) ? payload : [payload];
                for (let i = 0; i < rows.length; i++) {
                    const row = rows[i];
                    if (!row) continue;
                    if (row.chart_id || row.chartId) window.__poChartId = String(row.chart_id || row.chartId);
                    let settings = row.settings;
                    if (typeof settings === 'string') {
                        try { settings = JSON.parse(settings); } catch (_) { settings = null; }
                    }
                    if (!settings || typeof settings !== 'object') continue;
                    if (settings.chartId) window.__poChartId = String(settings.chartId);
                    const period = parsePeriodSeconds(settings.chartPeriod || settings.fastTimeframe || settings.period || 0);
                    if (period > 0) {
                        window.__poChartPeriodSec = period;
                        if (PosChartOverlay && PosChartOverlay.enabled) {
                            try { PosChartOverlay.scheduleSync(false); } catch (_) {}
                        }
                    }
                }
                return;
            }

            const core = window.__poCore;
            if (!core) {
                return;
            }

            if (eventName === 'successopenOrder' && core._handleMultiOpen && core._handleMultiOpen(payload)) return;
            if (eventName === 'failopenOrder' && core._handleMultiFail && core._handleMultiFail(payload)) return;

            // PO отклонил create — стоп-спам; иногда в payload всё же есть id
            if (eventName === 'failindicator/create') {
                const rid = payload && payload.requestId;
                if (rid && window.__poIndFailLogged === rid) return;
                if (rid) window.__poIndFailLogged = rid;
                window.__poIndCreateFailUntil = Date.now() + 45000;
                const t = payload && payload.type;
                if (t) {
                    if (!window.__poIndFailTypes) window.__poIndFailTypes = {};
                    window.__poIndFailTypes[String(t)] = Date.now() + 90000;
                }
                // если сервер всё же вернул id — запомним шаблон и запись
                if (payload && payload.id != null) {
                    upsertPoInd(payload);
                    if (payload.type && payload.settings) {
                        if (!window.__poIndTemplates) window.__poIndTemplates = {};
                        window.__poIndTemplates[payload.type] = JSON.parse(JSON.stringify(payload.settings));
                    }
                }
                try {
                    if (core.log) core.log('⚠️ PO failindicator/create' + (t ? ' (' + t + ')' : '') + ' — пауза 45с');
                } catch (_) {}
                return;
            }

            if (eventName === 'successindicator/load') {
                ingestPoIndicatorLoad(payload);
                if (PosChartOverlay && PosChartOverlay.enabled) {
                    try { PosChartOverlay.scheduleSync(false); } catch (_) {}
                }
                return;
            }

            if (eventName === 'successindicator/create') {
                if (payload) {
                    upsertPoInd(payload);
                    if (payload.type && payload.settings) {
                        if (!window.__poIndTemplates) window.__poIndTemplates = {};
                        window.__poIndTemplates[payload.type] = JSON.parse(JSON.stringify(payload.settings));
                    }
                }
                window.__poIndCreateFailUntil = 0;
                if (PosChartOverlay && PosChartOverlay.enabled) {
                    PosChartOverlay._lastKey = '';
                    try { PosChartOverlay.scheduleSync(false); } catch (_) {}
                }
                return;
            }

            if (eventName === 'successindicator/delete') {
                if (payload && payload.id != null) removePoIndId(payload.id);
                return;
            }

            if (eventName === 'successindicator/deleteAll') {
                window.__poIndList = [];
                return;
            }

            // ── updateStream: live price ticks ──────────────────────
            // PocketOption format: [["GBPUSD", timestamp, price], ...] (array of arrays)
            if (eventName === 'updateStream') {
                const rows = Array.isArray(payload) ? payload : [payload];
                for (const row of rows) {
                    if (!row) continue;
                    // PO format: ["ASSET", timestamp, price]
                    if (Array.isArray(row) && typeof row[0] === 'string' && row.length >= 3) {
                        rememberRawAsset(row[0]);
                        const asset = normalizeAssetName(row[0]);
                        const price = parseFloat(row[2]);
                        const ts    = row[1] ? row[1] * 1000 : Date.now();
                        if (asset && price > 0) core.onPrice({ asset, price, timestamp: ts });
                    // Object format: {asset, prices:[{price,time}]}
                    } else if (row && row.asset && Array.isArray(row.prices)) {
                        rememberRawAsset(row.asset);
                        const asset = normalizeAssetName(row.asset);
                        for (const tick of row.prices) {
                            const price = parseFloat(tick.price || tick.p || 0);
                            if (price > 0) core.onPrice({ asset, price, timestamp: (tick.time || Date.now() / 1000) * 1000 });
                        }
                    // Object flat: {asset, price}
                    } else if (row && row.asset && (row.price || row.close)) {
                        const asset = normalizeAssetName(row.asset);
                        const price = parseFloat(row.price || row.close || 0);
                        if (price > 0) core.onPrice({ asset, price, timestamp: Date.now() });
                    }
                }
                return;
            }

            // ── updateHistoryNewFast: bulk price history ──
            // PocketOption format: {asset:"GBPUSD", period:60, history:[[timestamp, price], ...]}
            if (eventName === 'updateHistoryNewFast' || eventName === 'updateHistoryNew' || eventName === 'loadHistoryPeriod' || eventName === 'loadHistoryPeriodFast') {
                window.__poHistorySeen = true;
                window.__poHistoryReadyAt = Date.now();
                const data = Array.isArray(payload) ? payload[0] : payload;
                if (data && data.asset && Array.isArray(data.history)) {
                    ingestHistoryRows(data.asset, data.history, data.period);
                    return;
                }
                if (data && data.asset && Array.isArray(data.data)) {
                    ingestHistoryRows(data.asset, data.data, data.period);
                    return;
                }
                // Legacy: array of objects or arrays
                if (payload && payload.asset && Array.isArray(payload.history)) {
                    ingestHistoryRows(payload.asset, payload.history, payload.period);
                    return;
                }
                const domAsset = core._domAsset || core._lastAsset;
                const getAsset = (d) => {
                    if (!d) return domAsset;
                    return (d.asset || d.a || (typeof d[0] === 'string' ? d[0] : null) || domAsset || '').toString();
                };
                let asset = getAsset(payload);
                let rows = null;
                if (Array.isArray(payload)) {
                    if (Array.isArray(payload[0])) {
                        rows = payload;
                    } else if (typeof payload[0] === 'object' && payload[0] !== null) {
                        asset = getAsset(payload[0]);
                        rows = payload[0].history || payload[0].data || payload;
                    } else {
                        rows = payload;
                    }
                } else if (payload && typeof payload === 'object') {
                    asset = getAsset(payload);
                    rows = payload.history || payload.data || payload.candles;
                }
                if (!asset || asset === 'UNKNOWN') asset = domAsset || '';
                if (Array.isArray(rows) && asset) ingestHistoryRows(asset, rows, payload && payload.period);
                return;
            }

            // history/list/v2 → {"asset":"CADCHF_otc","period":60,"history":[[time,price,dir],...]}
            if (eventName === 'history/list/v2') {
                const data = Array.isArray(payload) ? payload[0] : payload;
                if (!data || !data.asset || !Array.isArray(data.history)) {
                    console.warn('[PocketOption Signal] history/list/v2: invalid data structure!', data);
                    return;
                }
                ingestHistoryRows(data.asset, data.history, data.period);
                return;
            }

            // quotes/stream → [["CADCHF_otc", timestamp, price, direction], ...]
            if (eventName === 'quotes/stream') {
                const rows = Array.isArray(payload[0]) ? payload : [payload];
                let count = 0;
                for (const row of rows) {
                    if (!Array.isArray(row) || row.length < 3) continue;
                    if (typeof row[0] !== 'string') continue;
                    rememberRawAsset(row[0]);
                    const asset = normalizeAssetName(row[0]);
                    const price = parseFloat(row[2]);
                    const ts    = row[1];
                    if (!asset || isNaN(price) || price <= 0) continue;
                    const detail = { type: 'POROBOT_WS_PRICE', asset, price, timestamp: ts * 1000 };
                    window.postMessage(detail, '*');
                    core.onPrice(detail);
                    count++;
                }
                if (!window._posStreamLogged) {
                    window._posStreamLogged = true;
                    console.log('[PocketOption Signal] quotes/stream first tick processed, rows:', rows.length, 'accepted:', count, 'payload sample:', JSON.stringify(payload).substring(0, 100));
                }
                return;
            }

            // ── successcloseOrder: PocketOption realtime order close ──
            // Payload: {profit: totalReturn, deals: [{id, amount, profit, percentProfit, ...}], balance?}
            if (eventName === 'successcloseOrder') {
                // После закрытия сделки форсируем чтение баланса из DOM
                const newBal = parseFloat(payload?.balance ?? payload?.wallet ?? NaN);
                if (!isNaN(newBal) && newBal >= 0) {
                    window._poLastWsBalance = newBal;
                }
                try {
                    if (typeof postBalanceUpdate === 'function') {
                        setTimeout(function() { postBalanceUpdate(true); }, 50);
                        setTimeout(function() { postBalanceUpdate(true); }, 400);
                        setTimeout(function() { postBalanceUpdate(true); }, 1200);
                    } else if (!isNaN(newBal) && newBal >= 0) {
                        window.postMessage({ type: 'POROBOT_BALANCE', balance: newBal }, '*');
                    }
                } catch (_) {}
                const deals = Array.isArray(payload?.deals) ? payload.deals
                            : Array.isArray(payload)         ? payload
                            : [payload];
                if (!core.isRunning && !(core._multiTradesById && core._multiTradesById.size) && !(core._multiPendingByRequestId && core._multiPendingByRequestId.size)) return;
                for (const deal of deals) {
                    if (!deal) continue;
                    if (core._handleMultiClose && core._handleMultiClose(deal)) continue;
                    if (!core.isRunning) continue;
                    const netProfit = parseFloat(deal.profit ?? 0);
                    const amount    = parseFloat(deal.amount ?? 1);
                    // WIN = net profit > 0; LOSS = profit is 0 or negative (lost investment)
                    const result    = netProfit > 0 ? 'WIN' : 'LOSE';
                    console.log('[PocketOption Signal] Trade result:', result, 'profit:', netProfit, 'amount:', amount);
                    if (core?.onTradeResult) core.onTradeResult({ id: deal.id ?? deal.ticket ?? null, result, profit: netProfit > 0 ? netProfit : -amount, amount, timestamp: Date.now() });
                }
                return;
            }

            // deal result - legacy event names
            const isRealtimeClose = eventName === 's_orders/close' ||
                (eventName.includes('close') && (eventName.includes('option') || eventName.includes('deal')) && !eventName.includes('list'));
            
            if (isRealtimeClose) {
                if (!core.isRunning) return;
                const d = Array.isArray(payload) ? payload[0] : payload;
                if (!d) return;
                const items = Array.isArray(d) ? d : [d];
                for (const item of items) {
                    if (!item) continue;
                    if (core._handleMultiClose && core._handleMultiClose(item)) continue;
                    const status = (item.status || item.result || item.state || '').toString().toLowerCase();
                    const rawProfit = parseFloat(item.profit ?? NaN);
                    const investment = parseFloat(item.amount || item.investment || 1);
                    let result = null;
                    let netProfit = 0;
                    if (status === 'draw' || status === 'equal') { result = 'DRAW'; }
                    else if (status === 'win' || rawProfit > 0) { result = 'WIN'; netProfit = rawProfit; }
                    else { result = 'LOSE'; netProfit = -investment; } // profit=0 or negative = LOSE
                    if (result && core?.onTradeResult) core.onTradeResult({ id: item.id ?? item.ticket ?? null, result, profit: netProfit, amount: investment, timestamp: Date.now() });
                }
                return;
            }

            // orders/closed/list on page load - skip entirely (historical data)
            if (eventName === 'orders/closed/list' || eventName === 'orders/opened/list') {
                return;
            }

            // Настроение толпы: chafor / depth/change → [["ASSET", callPct], ...]
            if (eventName === 'chafor' || eventName === 'depth/change' || eventName === 'sentiment') {
                ingestSentimentPayload(payload);
                return;
            }
        }

        function ingestSentimentPayload(payload) {
            const core = window.__poCore;
            if (!core || !core.onSentiment) return;
            const rows = Array.isArray(payload)
                ? (Array.isArray(payload[0]) || (payload[0] && typeof payload[0] === 'object') ? payload : [payload])
                : [payload];
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                if (!row) continue;
                let asset = '', up = NaN, down = NaN;
                if (Array.isArray(row) && typeof row[0] === 'string') {
                    asset = row[0];
                    const v0 = parseFloat(row[1]);
                    const v1 = row.length >= 3 ? parseFloat(row[2]) : NaN;
                    if (!isNaN(v1)) {
                        up = v0; down = v1;
                    } else if (!isNaN(v0)) {
                        // Одно число: % CALL (0–100 или 0–1)
                        up = v0 <= 1 ? v0 * 100 : v0;
                        down = 100 - up;
                    }
                } else if (typeof row === 'object') {
                    asset = row.asset || row.symbol || row.pair || '';
                    if (row.up != null || row.call != null || row.buy != null) {
                        up = parseFloat(row.up ?? row.call ?? row.buy);
                        down = parseFloat(row.down ?? row.put ?? row.sell);
                        if (isNaN(down) && !isNaN(up)) down = 100 - (up <= 1 ? up * 100 : up);
                        if (!isNaN(up) && up <= 1) up *= 100;
                        if (!isNaN(down) && down <= 1) down *= 100;
                    } else if (row.value != null || row.sentiment != null || row.percent != null) {
                        up = parseFloat(row.value ?? row.sentiment ?? row.percent);
                        if (!isNaN(up)) {
                            if (up <= 1) up *= 100;
                            down = 100 - up;
                        }
                    }
                }
                if (!asset || isNaN(up)) continue;
                if (isNaN(down)) down = 100 - up;
                rememberRawAsset(asset);
                core.onSentiment({ asset, up, down });
            }
        }



        return ws;
    };

    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket.prototype = OriginalWebSocket.prototype;

    // ── История свечей: запрос у PO ───────────────────────────────────
    function rememberRawAsset(raw) {
        if (!raw || typeof raw !== 'string') return;
        const norm = normalizeAssetName(raw);
        if (!norm) return;
        if (!window.__poRawAssetByNorm) window.__poRawAssetByNorm = {};
        window.__poRawAssetByNorm[norm] = raw;
        const base = assetBase(norm);
        allEquivalentBases(base).forEach(function(eq) {
            const altNorm = withOtcSuffix(eq, norm);
            if (!window.__poRawAssetByNorm[altNorm]) window.__poRawAssetByNorm[altNorm] = raw;
        });
        // также для алиасов DOM↔WS
        const core = window.__poCore;
        if (core && core._domAsset && assetsMatch(norm, core._domAsset)) {
            window.__poRawAssetByNorm[normalizeAssetName(core._domAsset)] = raw;
            registerAssetAliasNorms(core._domAsset, norm);
        }
    }

    function toPoAssetId(normOrRaw) {
        if (!normOrRaw) return '';
        const norm = normalizeAssetName(normOrRaw);
        if (window.__poRawAssetByNorm && window.__poRawAssetByNorm[norm]) {
            return window.__poRawAssetByNorm[norm];
        }
        const base = assetBase(norm);
        const equivalents = allEquivalentBases(base);
        for (const eq of equivalents) {
            const candidate = withOtcSuffix(eq, norm);
            if (window.__poRawAssetByNorm && window.__poRawAssetByNorm[candidate]) {
                return window.__poRawAssetByNorm[candidate];
            }
        }
        const mapped = aliasBase(base);
        const poBase = mapped !== base ? mapped : base;
        const resolved = withOtcSuffix(poBase, norm);
        // PO часто шлёт OTC в нижнем регистре: XNGUSD_otc
        if (/_OTC$/i.test(resolved)) return resolved.replace(/_OTC$/i, '_otc');
        return resolved;
    }

    function getActivePoSocket() {
        const records = window.__po_wsConnections || [];
        const active = window.__po_ws;
        if (active && active.readyState === 1 && records.some(function(r) { return r.ws === active; })) return active;
        const candidates = records.filter(function(r) {
            return r.ws && r.ws.readyState === 1;
        }).sort(function(a, b) {
            return (b.lastDataAt || 0) - (a.lastDataAt || 0);
        });
        if (!candidates.length) return null;
        window.__po_ws = candidates[0].ws;
        window.__po_wsUrl = candidates[0].url;
        return window.__po_ws;
    }

    function requestAssetHistory(assetNorm, periodSec) {
        const ws = getActivePoSocket();
        if (!ws || !assetNorm) return false;
        const period = Math.max(3, parseInt(periodSec, 10) || 60);
        const raw = toPoAssetId(assetNorm);
        if (!raw) return false;
        const time = Math.floor(Date.now() / 1000);
        // offset в секундах: с запасом под minCandles (≈80 свечей)
        const offset = Math.max(period * 90, period <= 30 ? 9000 : 45000);
        try {
            ws.send('42["changeSymbol",' + JSON.stringify({ asset: raw, period: period }) + ']');
        } catch (_) {}
        try {
            const payload = { asset: raw, index: time, time: time, offset: offset, period: period };
            ws.send('42["loadHistoryPeriod",' + JSON.stringify(payload) + ']');
            subscribeSentiment(assetNorm);
            return true;
        } catch (_) {
            return false;
        }
    }

    function subscribeSentiment(assetNorm) {
        const ws = getActivePoSocket();
        if (!ws || !assetNorm) return false;
        const raw = toPoAssetId(assetNorm);
        if (!raw) return false;
        const prev = window.__poSentimentSub;
        if (prev && prev !== raw) {
            try { ws.send('42["unsubfor",' + JSON.stringify(prev) + ']'); } catch (_) {}
        }
        if (prev === raw && window.__poSentimentSubAt && (Date.now() - window.__poSentimentSubAt < 8000)) {
            return true;
        }
        try {
            ws.send('42["subfor",' + JSON.stringify(raw) + ']');
            window.__poSentimentSub = raw;
            window.__poSentimentSubAt = Date.now();
            return true;
        } catch (_) {
            return false;
        }
    }

    const MAX_STORED_CANDLES = 600;

    // Порядок полей в OHLC-строке PO меняется между эндпоинтами, поэтому
    // определяем раскладку по самим данным: high - максимум, low - минимум.
    function detectOhlcLayout(rows) {
        let ochl = 0, ohlc = 0, checked = 0;
        for (let i = 0; i < rows.length && checked < 40; i++) {
            const r = rows[i];
            if (!Array.isArray(r) || r.length < 5) continue;
            const a = parseFloat(r[1]), b = parseFloat(r[2]), c = parseFloat(r[3]), d = parseFloat(r[4]);
            if (!isFinite(a) || !isFinite(b) || !isFinite(c) || !isFinite(d)) continue;
            if (a <= 0 || b <= 0 || c <= 0 || d <= 0) continue;
            checked++;
            const hi = Math.max(a, b, c, d), lo = Math.min(a, b, c, d);
            if (c >= hi && d <= lo) ochl++;
            if (b >= hi && c <= lo) ohlc++;
        }
        if (!checked) return null;
        if (ochl >= ohlc && ochl > 0) return { o: 1, c: 2, h: 3, l: 4 };
        if (ohlc > 0) return { o: 1, h: 2, l: 3, c: 4 };
        return null;
    }

    function storeRealCandle(asset, periodSec, candle) {
        const core = window.__poCore;
        if (!core || !periodSec || !candle) return;
        if (!core._ohlc[asset]) core._ohlc[asset] = {};
        if (!core._ohlc[asset][periodSec]) core._ohlc[asset][periodSec] = new Map();
        const store = core._ohlc[asset][periodSec];
        store.set(candle.ts, candle);
        if (store.size > MAX_STORED_CANDLES) {
            const keys = Array.from(store.keys()).sort(function(a, b) { return a - b; });
            for (let i = 0; i < keys.length - MAX_STORED_CANDLES; i++) store.delete(keys[i]);
        }
    }

    function getRealCandles(core, asset, candleMs) {
        if (!core || !core._ohlc || !asset || !candleMs) return null;
        const periodSec = Math.round(candleMs / 1000);
        let byPeriod = core._ohlc[asset];
        if (!byPeriod) {
            const keys = Object.keys(core._ohlc);
            for (let i = 0; i < keys.length; i++) {
                if (assetsMatch(keys[i], asset)) { byPeriod = core._ohlc[keys[i]]; break; }
            }
        }
        const store = byPeriod && byPeriod[periodSec];
        if (!store || !store.size) return null;
        const arr = Array.from(store.values());
        arr.sort(function(a, b) { return a.ts - b.ts; });
        return arr;
    }

    function ingestHistoryRows(assetRaw, rows, periodHint) {
        const core = window.__poCore;
        if (!core || !rows || !rows.length) return 0;
        rememberRawAsset(assetRaw);
        const asset = normalizeAssetName(assetRaw);
        const periodSec = parseInt(periodHint, 10) || 0;
        const layout = periodSec ? detectOhlcLayout(rows) : null;
        let count = 0;
        let ohlcCount = 0;
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row) continue;
            let price = 0, ts = 0;
            let bar = null;
            if (Array.isArray(row)) {
                ts = parseFloat(row[0]) * (row[0] > 1e12 ? 1 : 1000);
                if (layout && row.length >= 5) {
                    const o = parseFloat(row[layout.o]);
                    const h = parseFloat(row[layout.h]);
                    const l = parseFloat(row[layout.l]);
                    const c = parseFloat(row[layout.c]);
                    if (o > 0 && h > 0 && l > 0 && c > 0) {
                        bar = { open: o, high: Math.max(o, h, l, c), low: Math.min(o, h, l, c), close: c };
                        price = c;
                    }
                }
                if (!bar) price = parseFloat(row.length >= 5 && row[2] != null ? row[2] : row[1]);
            } else if (typeof row === 'object') {
                ts = parseFloat(row.time || row.t || row.ts || 0) * ((row.time || row.t || 0) > 1e12 ? 1 : 1000);
                price = parseFloat(row.close || row.c || row.price || row.p || 0);
                const o = parseFloat(row.open != null ? row.open : row.o);
                const h = parseFloat(row.high != null ? row.high : row.h);
                const l = parseFloat(row.low != null ? row.low : row.l);
                if (periodSec && o > 0 && h > 0 && l > 0 && price > 0) {
                    bar = { open: o, high: Math.max(o, h, l, price), low: Math.min(o, h, l, price), close: price };
                }
            }
            if (!price || price <= 0 || !ts) continue;
            if (bar && periodSec) {
                const bucketMs = periodSec * 1000;
                bar.ts = Math.floor(ts / bucketMs) * bucketMs;
                storeRealCandle(asset, periodSec, bar);
                ohlcCount++;
            }
            core.onPrice({ asset: asset, price: price, timestamp: ts, fromHistory: true });
            count++;
        }
        if (ohlcCount && !core._ohlcLogged) {
            core._ohlcLogged = true;
            core.log('🕯 Настоящие свечи от PO: ' + ohlcCount + ' × ' + periodSec + 'с');
        }
        if (count > 0 && core._ticks[asset]) {
            core._ticks[asset].sort(function(a, b) { return a.ts - b.ts; });
            // убрать почти-дубликаты после сортировки
            const uniq = [];
            for (let i = 0; i < core._ticks[asset].length; i++) {
                const t = core._ticks[asset][i];
                const prev = uniq[uniq.length - 1];
                if (prev && Math.abs(prev.ts - t.ts) < 50) {
                    uniq[uniq.length - 1] = t;
                } else {
                    uniq.push(t);
                }
            }
            core._ticks[asset] = uniq;
            core._prices[asset] = uniq.map(function(t) { return t.price; });
        }
        if (count > 0 && core._domAsset && assetsMatch(asset, core._domAsset)) {
            core._wsAsset = asset;
            learnAssetAlias(core._domAsset, asset);
            core._historyLoadedAt = Date.now();
            const ctx = core._getAnalysisContext(asset);
            core.log('📥 История: ' + asset + ' +' + count + ' точек → свечи ' + ctx.candleCount + '/' + ctx.minRequired +
                (periodHint ? ' (period ' + periodHint + 's)' : ''));
        }
        return count;
    }
    class CoreIndicators {
        static sma(p, n) { if (!p||p.length<n) return null; return p.slice(-n).reduce((a,b)=>a+b,0)/n; }
        static ema(p, n) {
            if (!p||p.length<n) return null;
            const k=2/(n+1); let e=p.slice(0,n).reduce((a,b)=>a+b,0)/n;
            for (let i=n;i<p.length;i++) e=p[i]*k+e*(1-k); return e;
        }
        static rsi(p, n=14) {
            if (!p||p.length<=n) return null;
            let g=0,l=0;
            for (let i=p.length-n;i<p.length;i++) { const d=p[i]-p[i-1]; if(d>=0) g+=d; else l-=d; }
            const ag=g/n, al=l/n; if(al===0) return 100;
            return 100-(100/(1+ag/al));
        }
        static bb(p, n=20, m=2) {
            if (!p||p.length<n) return null;
            const sl=p.slice(-n), mid=sl.reduce((a,b)=>a+b,0)/n;
            const std=Math.sqrt(sl.reduce((a,b)=>a+(b-mid)**2,0)/n);
            return { upper:mid+m*std, mid, lower:mid-m*std };
        }
        static macd(p, f=12, s=26, sig=9) {
            if (!p||p.length<s+sig) return null;
            const ef=CoreIndicators.ema(p,f), es=CoreIndicators.ema(p,s);
            if (!ef||!es) return null;
            const ml=ef-es;
            const mv=[]; for(let i=s;i<p.length;i++){const a=CoreIndicators.ema(p.slice(0,i+1),f),b=CoreIndicators.ema(p.slice(0,i+1),s);if(a&&b)mv.push(a-b);}
            if(mv.length<sig) return null;
            const sl2=mv.slice(-sig).reduce((a,b)=>a+b,0)/sig;
            return { macd:ml, signal:sl2, hist:ml-sl2 };
        }
        static stoch(p, k=14, d=3) {
            if (!p||p.length<k+d) return null;
            const kv=[]; for(let i=p.length-d;i<p.length;i++){const sl=p.slice(i-k+1,i+1);const hi=Math.max(...sl),lo=Math.min(...sl);kv.push(hi===lo?50:((p[i]-lo)/(hi-lo))*100);}
            return { k:kv[kv.length-1], d:kv.reduce((a,b)=>a+b,0)/kv.length };
        }
        // Классический стохастик считается по экстремумам свечей, а не по закрытиям
        static stochHL(candles, k=14, d=3) {
            if (!candles || candles.length < k + d) return null;
            const kv = [];
            for (let i = candles.length - d; i < candles.length; i++) {
                let hi = -Infinity, lo = Infinity;
                for (let j = i - k + 1; j <= i; j++) {
                    if (candles[j].high > hi) hi = candles[j].high;
                    if (candles[j].low < lo) lo = candles[j].low;
                }
                const c = candles[i].close;
                kv.push(hi === lo ? 50 : ((c - lo) / (hi - lo)) * 100);
            }
            return { k: kv[kv.length - 1], d: kv.reduce((a, b) => a + b, 0) / kv.length };
        }
        static cci(p, n=20) {
            if (!p||p.length<n) return null;
            const sl=p.slice(-n), mean=sl.reduce((a,b)=>a+b,0)/n;
            const mad=sl.reduce((a,b)=>a+Math.abs(b-mean),0)/n;
            return mad===0?0:(p[p.length-1]-mean)/(0.015*mad);
        }
        // CCI по типичной цене (H+L+C)/3 - каноничный вариант
        static cciTP(candles, n=20) {
            if (!candles || candles.length < n) return null;
            const tp = [];
            for (let i = candles.length - n; i < candles.length; i++) {
                tp.push((candles[i].high + candles[i].low + candles[i].close) / 3);
            }
            const mean = tp.reduce((a, b) => a + b, 0) / n;
            const mad = tp.reduce((a, b) => a + Math.abs(b - mean), 0) / n;
            return mad === 0 ? 0 : (tp[tp.length - 1] - mean) / (0.015 * mad);
        }
        static atr(candles, n=14) {
            if (!candles || candles.length < n + 1) return null;
            let sum = 0;
            for (let i = candles.length - n; i < candles.length; i++) {
                const prevClose = candles[i - 1].close;
                const tr = Math.max(
                    candles[i].high - candles[i].low,
                    Math.abs(candles[i].high - prevClose),
                    Math.abs(candles[i].low - prevClose)
                );
                sum += tr;
            }
            return sum / n;
        }
        static trend(p, n=5) {
            if (!p||p.length<n) return 'NEUTRAL';
            const cur=p[p.length-1], old=p[p.length-n];
            return cur>old?'UP':cur<old?'DOWN':'NEUTRAL';
        }
    }

    // ── Native chart indicators (встроенные линии PO = идеальное совпадение) ──
    function sleepMs(ms) {
        return new Promise(function(resolve) { setTimeout(resolve, ms); });
    }

    function setNativeNumberInput(input, value) {
        if (!input) return;
        const v = String(value);
        const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        if (proto && proto.set) proto.set.call(input, v);
        else input.value = v;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        try { input.dispatchEvent(new InputEvent('input', { bubbles: true, data: v })); } catch (_) {}
    }

    function clickEl(el) {
        if (!el) return false;
        try {
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            if (typeof el.click === 'function') el.click();
            return true;
        } catch (_) {
            try { el.click(); return true; } catch (_2) { return false; }
        }
    }

    function parseChartIntervalLabel(raw) {
        const lab = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
        if (!lab) return null;
        let m = lab.match(/^S(\d{1,2})$/);
        if (m) {
            const sec = parseInt(m[1], 10);
            if (sec >= 1 && sec <= 59) return { label: 'S' + sec, periodSec: sec, candleMs: sec * 1000 };
        }
        m = lab.match(/^M(\d{1,2})$/);
        if (m) {
            const min = parseInt(m[1], 10);
            if (min >= 1 && min <= 59) return { label: 'M' + min, periodSec: min * 60, candleMs: min * 60 * 1000 };
        }
        m = lab.match(/^H(\d{1,2})$/);
        if (m) {
            const h = parseInt(m[1], 10);
            if (h >= 1 && h <= 48) return { label: 'H' + h, periodSec: h * 3600, candleMs: h * 3600 * 1000 };
        }
        m = lab.match(/^D(\d{1,2})$/);
        if (m) {
            const d = parseInt(m[1], 10);
            if (d >= 1 && d <= 31) return { label: 'D' + d, periodSec: d * 86400, candleMs: d * 86400 * 1000 };
        }
        return null;
    }

    // Реальный интервал свечей графика (S5/M1/...) + chartPeriod из updateCharts
    function readPlatformChartInterval() {
        if (window.__poChartPeriodSec && window.__poChartPeriodSec > 0) {
            const sec = window.__poChartPeriodSec;
            if (sec < 60) return { label: 'S' + sec, periodSec: sec, candleMs: sec * 1000 };
            if (sec % 86400 === 0) return { label: 'D' + (sec / 86400), periodSec: sec, candleMs: sec * 1000 };
            if (sec % 3600 === 0) return { label: 'H' + (sec / 3600), periodSec: sec, candleMs: sec * 1000 };
            if (sec % 60 === 0) return { label: 'M' + (sec / 60), periodSec: sec, candleMs: sec * 1000 };
            return { label: 'S' + sec, periodSec: sec, candleMs: sec * 1000 };
        }
        const counter = document.querySelector('.items__link--chart-type .counter__icon, .items__link--chart-type .counter span');
        if (counter) {
            const p = parseChartIntervalLabel(counter.textContent);
            if (p) return p;
        }
        const tip = document.querySelector('.items__link--chart-type .tooltip-text');
        if (tip) {
            const m = String(tip.textContent || '').match(/\b(S|M|H|D)\d{1,2}\b/i);
            if (m) {
                const p = parseChartIntervalLabel(m[0]);
                if (p) return p;
            }
        }
        const active = document.querySelector('.time-frames-block li.active span, .time-frames-block li.active a');
        if (active) {
            const p = parseChartIntervalLabel(active.textContent);
            if (p) return p;
        }
        return { label: 'S5', periodSec: 5, candleMs: 5000 };
    }

    function getCoreParam(core, ind, key, def) {
        if (core && typeof core._getParam === 'function') return core._getParam(ind, key, def, def);
        const c = core && core.config && core.config.indConfig && core.config.indConfig[String(ind).toUpperCase()];
        const v = c && c[key];
        if (v != null && !isNaN(parseFloat(v))) return parseFloat(v);
        return def;
    }

    function buildDesiredPoIndicators(core) {
        const list = (core && core._indicatorList && core._indicatorList())
            || (core && core.config && core.config.indicators)
            || [];
        const ids = (Array.isArray(list) ? list : []).map(function(x) { return String(x).toUpperCase(); });
        const out = [];
        const push = function(dataType, titleRe, values, tag) {
            out.push({ dataType: dataType, titleRe: titleRe, values: values.map(Number), tag: tag || dataType });
        };

        // Приоритет на графике: BB (overlay) → RSI → EMA → MACD…
        const MAX_CHART_INDS = 4;
        const has = function(id) { return ids.indexOf(id) >= 0; };

        if (has('BB')) {
            push('bb', /Bollinger/i, [
                getCoreParam(core, 'BB', 'period', 20),
                getCoreParam(core, 'BB', 'dev', 2)
            ], 'bb');
        }
        if (has('RSI') && out.length < MAX_CHART_INDS) {
            push('rsi', /RSI/i, [getCoreParam(core, 'RSI', 'period', 14)], 'rsi');
        }
        if (has('EMA') && out.length < MAX_CHART_INDS) {
            push('ma', /Moving Average/i, [getCoreParam(core, 'EMA', 'fast', 5)], 'ema-fast');
            if (out.length < MAX_CHART_INDS) {
                push('ma', /Moving Average/i, [getCoreParam(core, 'EMA', 'slow', 21)], 'ema-slow');
            }
        } else if (has('SMA') && out.length < MAX_CHART_INDS) {
            push('ma', /Moving Average/i, [getCoreParam(core, 'SMA', 'fast', 5)], 'sma-fast');
            if (out.length < MAX_CHART_INDS) {
                push('ma', /Moving Average/i, [getCoreParam(core, 'SMA', 'slow', 14)], 'sma-slow');
            }
        }
        if (has('MACD') && out.length < MAX_CHART_INDS) {
            push('macd', /MACD/i, [
                getCoreParam(core, 'MACD', 'fast', 12),
                getCoreParam(core, 'MACD', 'slow', 26),
                getCoreParam(core, 'MACD', 'signal', 9)
            ], 'macd');
        }
        if (has('STOCH') && out.length < MAX_CHART_INDS) {
            push('so', /Stochastic/i, [
                getCoreParam(core, 'STOCH', 'kPeriod', 14),
                getCoreParam(core, 'STOCH', 'dPeriod', 3)
            ], 'so');
        }
        if (has('PSAR') && out.length < MAX_CHART_INDS) {
            push('sar', /Parabolic|SAR/i, [], 'sar');
        }
        if (has('CCI') && out.length < MAX_CHART_INDS) {
            push('cci', /CCI/i, [getCoreParam(core, 'CCI', 'period', 20)], 'cci');
        }

        return out.slice(0, MAX_CHART_INDS);
    }

    // ── Native PO indicators via WebSocket (no DOM clicks) ───────────
    // DOM create/delete ломает main.js (failindicator/create → .time crash).
    const PO_IND_MANAGED = { bb: 1, rsi: 1, macd: 1, so: 1, cci: 1, sar: 1, ma: 1 };

    function poRequestId() {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
        let s = '';
        for (let i = 0; i < 21; i++) s += alphabet.charAt((Math.random() * alphabet.length) | 0);
        return s;
    }

    function getPoChartId() {
        return window.__poChartId || 'chart-1';
    }

    function getPoIndList() {
        if (!Array.isArray(window.__poIndList)) window.__poIndList = [];
        return window.__poIndList;
    }

    function upsertPoInd(item) {
        if (!item || item.id == null) return;
        const list = getPoIndList();
        const id = item.id;
        for (let i = 0; i < list.length; i++) {
            if (list[i] && list[i].id === id) {
                list[i] = Object.assign({}, list[i], item);
                return;
            }
        }
        list.push(item);
    }

    function removePoIndId(id) {
        window.__poIndList = getPoIndList().filter(function(x) { return !x || x.id !== id; });
    }

    function ingestPoIndicatorLoad(payload) {
        const list = (payload && payload.list) || [];
        window.__poIndList = Array.isArray(list) ? list.slice() : [];
        if (!window.__poIndTemplates) window.__poIndTemplates = {};
        for (let i = 0; i < window.__poIndList.length; i++) {
            const row = window.__poIndList[i];
            if (!row || !row.type || !row.settings) continue;
            window.__poIndTemplates[row.type] = JSON.parse(JSON.stringify(row.settings));
        }
    }

    function cloneJson(obj) {
        return JSON.parse(JSON.stringify(obj));
    }

    function defaultPoIndSettings(type, values, tag) {
        const learned = window.__poIndTemplates && window.__poIndTemplates[type];
        const base = learned ? cloneJson(learned) : null;
        const v = values || [];

        if (type === 'rsi') {
            const s = base || {
                lines: {
                    main: { lineWidth: 1, color: '#86da0e' },
                    overbought: { lineWidth: 1, color: '#00ffcc', level: 70, opacity: 60 },
                    middle: { lineWidth: 1, color: '#c0c0c0', level: 50, opacity: 30 },
                    oversold: { lineWidth: 1, color: '#f1c40f', level: 30, opacity: 60 }
                },
                period: 14
            };
            if (v[0] != null) s.period = v[0];
            return s;
        }
        if (type === 'bb') {
            const s = base || {
                lines: {
                    middle: { lineWidth: 1, color: '#86da0e' },
                    upper: { lineWidth: 1, color: '#00ffcc' },
                    lower: { lineWidth: 1, color: '#ff0000' },
                    background: { color: '#86da0e', opacity: 10 }
                },
                period: 20,
                deviation: 2
            };
            if (v[0] != null) s.period = v[0];
            if (v[1] != null) {
                if (s.deviation != null) s.deviation = v[1];
                else if (s.stdDev != null) s.stdDev = v[1];
                else s.deviation = v[1];
            }
            return s;
        }
        if (type === 'macd') {
            const s = base || {
                lines: {
                    histogram: {
                        colors: {
                            up: { color: '#86da0e', opacity: 70 },
                            down: { color: '#ff0000', opacity: 70 }
                        }
                    },
                    macd: { lineWidth: 1, color: '#86da0e' },
                    signal: { lineWidth: 1, color: '#ff0000' }
                },
                fastPeriod: 12,
                slowPeriod: 26,
                signalPeriod: 9
            };
            if (v[0] != null) s.fastPeriod = v[0];
            if (v[1] != null) s.slowPeriod = v[1];
            if (v[2] != null) s.signalPeriod = v[2];
            return s;
        }
        if (type === 'so') {
            const s = base || {
                lines: {
                    main: { lineWidth: 1, color: '#86da0e' },
                    signal: { lineWidth: 1, color: '#ff0000' },
                    overbought: { lineWidth: 1, color: '#00ffcc', level: 80, opacity: 60 },
                    oversold: { lineWidth: 1, color: '#f1c40f', level: 20, opacity: 60 }
                },
                kPeriod: 14,
                dPeriod: 3,
                slowing: 3
            };
            if (v[0] != null) s.kPeriod = v[0];
            if (v[1] != null) s.dPeriod = v[1];
            return s;
        }
        if (type === 'cci') {
            const s = base || {
                lines: {
                    main: { lineWidth: 1, color: '#86da0e' },
                    overbought: { lineWidth: 1, color: '#00ffcc', level: 100, opacity: 60 },
                    oversold: { lineWidth: 1, color: '#f1c40f', level: -100, opacity: 60 }
                },
                period: 20
            };
            if (v[0] != null) s.period = v[0];
            return s;
        }
        if (type === 'sar') {
            return base || {
                lines: { main: { color: '#86da0e', figure: 'dots' } },
                step: 0.02,
                max: 0.2
            };
        }
        if (type === 'ma') {
            const isEma = String(tag || '').indexOf('ema') === 0;
            // PO: method/maType часто число или строка; берём выученный шаблон если есть
            const s = base ? cloneJson(base) : {
                lines: { main: { lineWidth: 1, color: isEma ? '#86da0e' : '#2256ff', figure: 'line' } },
                period: 14,
                maType: isEma ? 'EMA' : 'SMA',
                method: isEma ? 'EMA' : 'SMA'
            };
            if (v[0] != null) s.period = v[0];
            if (isEma) {
                s.maType = 'EMA';
                s.method = 'EMA';
            } else if (String(tag || '').indexOf('sma') === 0) {
                s.maType = 'SMA';
                s.method = 'SMA';
            }
            return s;
        }
        return base || { lines: { main: { lineWidth: 1, color: '#86da0e' } }, period: (v[0] != null ? v[0] : 14) };
    }

    function poIndSettingsMatch(row, desired) {
        if (!row || !desired) return false;
        if (String(row.type) !== String(desired.dataType)) return false;
        const s = row.settings || {};
        const v = desired.values || [];
        const t = desired.dataType;
        if (t === 'rsi' || t === 'cci') {
            return v[0] == null || Math.abs((s.period || 0) - v[0]) < 0.051;
        }
        if (t === 'bb') {
            const dev = s.deviation != null ? s.deviation : s.stdDev;
            return (v[0] == null || Math.abs((s.period || 0) - v[0]) < 0.051) &&
                (v[1] == null || Math.abs((dev || 0) - v[1]) < 0.051);
        }
        if (t === 'macd') {
            return (v[0] == null || Math.abs((s.fastPeriod || 0) - v[0]) < 0.051) &&
                (v[1] == null || Math.abs((s.slowPeriod || 0) - v[1]) < 0.051) &&
                (v[2] == null || Math.abs((s.signalPeriod || 0) - v[2]) < 0.051);
        }
        if (t === 'so') {
            return (v[0] == null || Math.abs((s.kPeriod || 0) - v[0]) < 0.051) &&
                (v[1] == null || Math.abs((s.dPeriod || 0) - v[1]) < 0.051);
        }
        if (t === 'ma') {
            const wantEma = String(desired.tag || '').indexOf('ema') === 0;
            const isEma = String(s.maType || s.type || '').toLowerCase().indexOf('ema') >= 0;
            if (wantEma !== isEma && (s.maType != null || s.type != null)) return false;
            return v[0] == null || Math.abs((s.period || 0) - v[0]) < 0.051;
        }
        return true;
    }

    function sendPoWsEvent(name, payload) {
        const ws = getActivePoSocket();
        if (!ws) return false;
        try {
            ws.send('42' + JSON.stringify([name, payload]));
            return true;
        } catch (_) {
            return false;
        }
    }

    function wsCreateIndicator(desired) {
        if (Date.now() < (window.__poIndCreateFailUntil || 0)) return false;
        const failMap = window.__poIndFailTypes || {};
        if (failMap[desired.dataType] && Date.now() < failMap[desired.dataType]) return false;
        if (getPoIndList().length >= 12) return false;

        const payload = {
            requestId: poRequestId(),
            chartId: getPoChartId(),
            type: desired.dataType,
            settings: defaultPoIndSettings(desired.dataType, desired.values, desired.tag),
            visible: 1
        };
        if (!window.__poIndPending) window.__poIndPending = {};
        window.__poIndPending[payload.requestId] = desired.tag || desired.dataType;
        return sendPoWsEvent('indicator/create', payload);
    }

    function wsUpdateIndicator(row, desired) {
        if (!row || row.id == null) return false;
        const settings = defaultPoIndSettings(desired.dataType, desired.values, desired.tag);
        try {
            if (row.settings && row.settings.lines) settings.lines = cloneJson(row.settings.lines);
        } catch (_) {}
        return sendPoWsEvent('indicator/update', { id: row.id, settings: settings });
    }

    function wsDeleteIndicator(id) {
        if (id == null) return false;
        return sendPoWsEvent('indicator/delete', { id: id });
    }

    function wsLoadIndicators() {
        return sendPoWsEvent('indicator/load', {});
    }

    const PosChartOverlay = {
        enabled: false,
        _busy: false,
        _queued: false,
        _timer: null,
        _lastKey: '',
        _lastRunAt: 0,
        _loggedKey: '',

        setEnabled(on, patch) {
            const core = window.__poCore;
            if (!core) return;
            if (!core.config) core.config = {};
            if (patch && typeof patch === 'object') Object.assign(core.config, patch);
            core.config.chartOverlay = !!on;
            this.enabled = !!on;
            try {
                const staleCanvas = document.getElementById('pos-chart-overlay-canvas');
                if (staleCanvas) {
                    const wrap = staleCanvas.parentElement;
                    if (wrap && wrap.id !== 'pos-panel' && wrap.parentNode) wrap.parentNode.removeChild(wrap);
                    else if (staleCanvas.parentNode) staleCanvas.parentNode.removeChild(staleCanvas);
                }
            } catch (_) {}
            if (on) {
                try { claimPrimaryEngine(); } catch (_) {}
                this._lastKey = '';
                this._loggedKey = '';
                try { wsLoadIndicators(); } catch (_) {}
                this.startLoop();
                try {
                    const n = buildDesiredPoIndicators(core).length;
                    if (core.log) core.log('📉 Синк индикаторов PO: вкл (WS, до ' + n + ')');
                } catch (_) {}
            } else {
                this.stopLoop();
                try { if (core.log) core.log('📉 Синк индикаторов PO: выкл'); } catch (_) {}
            }
        },

        startLoop() {
            try { claimPrimaryEngine(); } catch (_) {}
            if (!shouldRunSignalEngine()) return;
            this.enabled = true;
            const self = this;
            if (this._timer) clearInterval(this._timer);
            this._timer = setInterval(function() { self.scheduleSync(false); }, 30000);
            this.scheduleSync(true);
        },

        stopLoop() {
            this.enabled = false;
            if (this._timer) { clearInterval(this._timer); this._timer = null; }
            if (this._soon) { clearTimeout(this._soon); this._soon = null; }
            this._lastKey = '';
            this._queued = false;
        },

        scheduleTick() { this.scheduleSync(false); },
        scheduleSync(force) {
            if (!this.enabled) return;
            const self = this;
            if (this._soon) clearTimeout(this._soon);
            this._soon = setTimeout(function() {
                self._soon = null;
                self.sync(!!force);
            }, force ? 1200 : 2500);
        },

        ensure() { return true; },
        clear() {},
        destroy() { this.stopLoop(); },
        draw() {},

        _desiredKey(core) {
            return buildDesiredPoIndicators(core).map(function(d) {
                return d.tag + ':' + d.values.join(',');
            }).join(';');
        },

        async sync(force) {
            if (!this.enabled) return;
            if (!shouldRunSignalEngine()) return;
            try { claimPrimaryEngine(); } catch (_) {}
            if (!isPrimarySignalFrame()) return;

            const core = window.__poCore;
            if (!core || !core.config || !core.config.chartOverlay) return;
            if (this._busy) { this._queued = true; return; }

            const key = this._desiredKey(core);
            if (!force && key === this._lastKey) return;

            const now = Date.now();
            if (now - this._lastRunAt < 3000) {
                this._queued = true;
                return;
            }

            this._busy = true;
            this._lastRunAt = now;
            try {
                const desired = buildDesiredPoIndicators(core);
                if (!getActivePoSocket()) {
                    if (core.log && this._loggedKey !== 'no-ws') {
                        this._loggedKey = 'no-ws';
                        core.log('⚠️ Нет WS для синка индикаторов');
                    }
                    return;
                }

                const list = getPoIndList().slice();
                const claimed = new Set();
                let created = 0;
                let missing = 0;

                for (let i = 0; i < desired.length; i++) {
                    const d = desired[i];
                    let match = null;
                    for (let j = 0; j < list.length; j++) {
                        const row = list[j];
                        if (!row || claimed.has(row.id)) continue;
                        if (poIndSettingsMatch(row, d)) { match = row; break; }
                    }
                    if (!match) {
                        for (let j = 0; j < list.length; j++) {
                            const row = list[j];
                            if (!row || claimed.has(row.id)) continue;
                            if (String(row.type) !== String(d.dataType)) continue;
                            if (d.dataType === 'ma') {
                                const wantEma = String(d.tag || '').indexOf('ema') === 0;
                                const mt = String((row.settings && (row.settings.maType || row.settings.type || row.settings.method)) || '').toLowerCase();
                                const isEma = mt === 'ema' || mt === '1' || mt.indexOf('ema') >= 0;
                                if (wantEma !== isEma) continue;
                            }
                            match = row;
                            break;
                        }
                    }

                    if (match) {
                        claimed.add(match.id);
                        if (!poIndSettingsMatch(match, d)) {
                            wsUpdateIndicator(match, d);
                            await sleepMs(200);
                        }
                    } else {
                        missing++;
                        // по одному create за проход — иначе PO глотает остальные
                        if (created < 1) {
                            if (wsCreateIndicator(d)) {
                                created++;
                                await sleepMs(700);
                            }
                        }
                    }
                }

                const needCount = {};
                for (let i = 0; i < desired.length; i++) {
                    needCount[desired[i].dataType] = (needCount[desired[i].dataType] || 0) + 1;
                }
                const haveCount = {};
                const fresh = getPoIndList();
                for (let i = 0; i < fresh.length; i++) {
                    const row = fresh[i];
                    if (!row || !PO_IND_MANAGED[row.type]) continue;
                    haveCount[row.type] = (haveCount[row.type] || 0) + 1;
                }
                for (let i = 0; i < fresh.length; i++) {
                    const row = fresh[i];
                    if (!row || !PO_IND_MANAGED[row.type]) continue;
                    const need = needCount[row.type] || 0;
                    if (need === 0) {
                        wsDeleteIndicator(row.id);
                        removePoIndId(row.id);
                        await sleepMs(150);
                    } else if ((haveCount[row.type] || 0) > need && !claimed.has(row.id)) {
                        wsDeleteIndicator(row.id);
                        removePoIndId(row.id);
                        haveCount[row.type]--;
                        await sleepMs(150);
                    }
                }

                // lastKey только когда всё на месте — иначе BB «залипал» один
                const stillMissing = missing > 0 || created > 0;
                if (!stillMissing) {
                    this._lastKey = this._desiredKey(core);
                } else {
                    this._lastKey = '';
                    this._queued = true;
                }
                if (core.log) {
                    const iv = readPlatformChartInterval();
                    const left = getPoIndList().length;
                    const types = getPoIndList().map(function(x) { return x && x.type; }).filter(Boolean).join(',');
                    const msg = '📉 Индикаторы PO (WS): ' + left + ' шт [' + types + '] · ' + iv.label +
                        (stillMissing ? ' · добиваю…' : '');
                    if (this._loggedKey !== msg) {
                        this._loggedKey = msg;
                        core.log(msg);
                    }
                }
            } catch (err) {
                try { console.warn('[PocketOption Signal] chart sync', err); } catch (_) {}
            } finally {
                this._busy = false;
                if (this._queued) {
                    this._queued = false;
                    this.scheduleSync(false);
                }
            }
        }
    };

    // ── Expiration-adaptive candle analysis ───────────────────────────
    // Профиль на каждую поддерживаемую экспирацию: раньше 30 и 60 секунд
    // (и все значения свыше минуты) делили одни и те же периоды, из-за чего
    // «разные таймфреймы» вели себя одинаково.
    const ANALYSIS_PROFILES = {
        3:   { rsiPeriod: 5,  smaFast: 2, smaSlow: 6,  emaFast: 2, emaSlow: 7,  bbPeriod: 8,  macdFast: 5,  macdSlow: 11, macdSig: 4, stochK: 5,  stochD: 2, cciPeriod: 8,  trendPeriod: 2, minStretch: 0.35 },
        15:  { rsiPeriod: 7,  smaFast: 3, smaSlow: 8,  emaFast: 3, emaSlow: 10, bbPeriod: 10, macdFast: 8,  macdSlow: 17, macdSig: 6, stochK: 9,  stochD: 3, cciPeriod: 12, trendPeriod: 3, minStretch: 0.40 },
        30:  { rsiPeriod: 9,  smaFast: 4, smaSlow: 10, emaFast: 4, emaSlow: 14, bbPeriod: 14, macdFast: 10, macdSlow: 21, macdSig: 7, stochK: 11, stochD: 3, cciPeriod: 16, trendPeriod: 4, minStretch: 0.45 },
        60:  { rsiPeriod: 10, smaFast: 5, smaSlow: 12, emaFast: 5, emaSlow: 18, bbPeriod: 20, macdFast: 12, macdSlow: 26, macdSig: 9, stochK: 14, stochD: 3, cciPeriod: 20, trendPeriod: 5, minStretch: 0.50 },
        180: { rsiPeriod: 13, smaFast: 5, smaSlow: 18, emaFast: 5, emaSlow: 21, bbPeriod: 20, macdFast: 12, macdSlow: 26, macdSig: 9, stochK: 14, stochD: 3, cciPeriod: 20, trendPeriod: 5, minStretch: 0.60 },
        300: { rsiPeriod: 14, smaFast: 5, smaSlow: 20, emaFast: 5, emaSlow: 21, bbPeriod: 20, macdFast: 12, macdSlow: 26, macdSig: 9, stochK: 14, stochD: 3, cciPeriod: 20, trendPeriod: 5, minStretch: 0.60 }
    };
    const PROFILE_STEPS = Object.keys(ANALYSIS_PROFILES).map(Number).sort(function(a, b) { return a - b; });

    function parsePeriodSeconds(value) {
        const raw = String(value == null ? '' : value).trim().toUpperCase();
        const match = raw.match(/^([SMH])\s*(\d+)$/);
        if (match) {
            const n = parseInt(match[2], 10);
            return n * (match[1] === 'S' ? 1 : match[1] === 'M' ? 60 : 3600);
        }
        const n = parseInt(raw, 10);
        return isFinite(n) && n >= 3 ? n : 0;
    }

    function getAnalysisProfile(expirationSec, timeframeSec) {
        const exp = Math.max(3, parseInt(expirationSec, 10) || 60);
        const candleSec = Math.max(3, parseInt(timeframeSec, 10) || exp);
        const candleMs = candleSec * 1000;
        let step = PROFILE_STEPS[0];
        for (let i = 0; i < PROFILE_STEPS.length; i++) {
            if (candleSec >= PROFILE_STEPS[i]) step = PROFILE_STEPS[i];
        }
        const base = ANALYSIS_PROFILES[step];
        const minCandles = candleSec <= 5
            ? Math.max(base.rsiPeriod, base.smaSlow, base.bbPeriod, base.stochK + base.stochD, base.trendPeriod) + 3
            : Math.max(base.rsiPeriod, base.smaSlow, base.bbPeriod, base.macdSlow + base.macdSig, base.stochK + base.stochD) + 2;
        return Object.assign({ exp, candleSec, candleMs, minCandles }, base);
    }

    function buildCandlesFromTicks(ticks, candleMs) {
        if (!ticks || !ticks.length || !candleMs) return [];
        const buckets = new Map();
        for (let i = 0; i < ticks.length; i++) {
            const t = ticks[i];
            const ts = t.ts || Date.now();
            const price = t.price;
            if (!price || price <= 0) continue;
            const bucket = Math.floor(ts / candleMs) * candleMs;
            if (!buckets.has(bucket)) {
                buckets.set(bucket, { open: price, high: price, low: price, close: price, ts: bucket });
            } else {
                const c = buckets.get(bucket);
                c.high = Math.max(c.high, price);
                c.low = Math.min(c.low, price);
                c.close = price;
            }
        }
        return Array.from(buckets.entries())
            .sort(function(a, b) { return a[0] - b[0]; })
            .map(function(entry) { return entry[1]; });
    }

    // Свечи из истории PO точнее тиковых: у них настоящие тени. Живые тики
    // используем только для текущей (формирующейся) свечи и для баров,
    // которых история ещё не прислала.
    function buildCandles(ticks, candleMs, realCandles) {
        const live = buildCandlesFromTicks(ticks, candleMs);
        if (!realCandles || !realCandles.length) return live;
        if (!live.length) return realCandles.slice();

        const merged = new Map();
        for (let i = 0; i < realCandles.length; i++) merged.set(realCandles[i].ts, realCandles[i]);
        const lastRealTs = realCandles[realCandles.length - 1].ts;

        for (let i = 0; i < live.length; i++) {
            const lc = live[i];
            if (lc.ts < lastRealTs) continue;
            const base = merged.get(lc.ts);
            if (!base) {
                merged.set(lc.ts, lc);
            } else {
                merged.set(lc.ts, {
                    ts: base.ts,
                    open: base.open,
                    high: Math.max(base.high, lc.high),
                    low: Math.min(base.low, lc.low),
                    close: lc.close
                });
            }
        }
        return Array.from(merged.values()).sort(function(a, b) { return a.ts - b.ts; });
    }

    function candleCloses(candles) {
        return candles.map(function(c) { return c.close; });
    }

    // Стиль индикатора определяет, каким должно быть подтверждение входа.
    // Трендовые ждут продолжения движения, возвратные - его истощения.
    const INDICATOR_META = {
        RSI:       { style: 'reversion', family: 'oscillator' },
        STOCH:     { style: 'reversion', family: 'oscillator' },
        CCI:       { style: 'reversion', family: 'oscillator' },
        BB:        { style: 'reversion', family: 'volatility' },
        EMA:       { style: 'trend',     family: 'ma' },
        SMA:       { style: 'trend',     family: 'ma' },
        TREND:     { style: 'trend',     family: 'ma' },
        MACD:      { style: 'trend',     family: 'momentum' },
        PSAR:      { style: 'trend',     family: 'momentum' },
        SENTIMENT: { style: 'neutral',   family: 'flow' }
    };

    function indicatorStyle(id) {
        const meta = INDICATOR_META[String(id || '').toUpperCase()];
        return meta ? meta.style : 'trend';
    }

    function indicatorFamily(id) {
        const meta = INDICATOR_META[String(id || '').toUpperCase()];
        return meta ? meta.family : 'other';
    }

    function getConfirmMode(config) {
        const m = String((config && config.confirmMode) || 'auto').toLowerCase();
        return ['auto', 'trend', 'reversion', 'off'].indexOf(m) >= 0 ? m : 'auto';
    }

    function getTriggerPolicy(config, triggerCount) {
        const p = String((config && config.triggerPolicy) || '').toLowerCase();
        if (p === 'any' || p === 'all') return p;
        return triggerCount > 1 ? 'all' : 'any';
    }

    // В auto режим подтверждения выводится из индикаторов, давших сигнал
    function resolveConfirmMode(config, triggerIds) {
        const mode = getConfirmMode(config);
        if (mode !== 'auto') return mode;
        const ids = Array.isArray(triggerIds) ? triggerIds : [];
        let rev = 0, tr = 0;
        for (let i = 0; i < ids.length; i++) {
            const s = indicatorStyle(ids[i]);
            if (s === 'reversion') rev++;
            else if (s === 'trend') tr++;
        }
        if (!rev && !tr) return 'off';
        return rev > tr ? 'reversion' : 'trend';
    }

    function candleParts(candle) {
        const range = Math.max(candle.high - candle.low, 1e-12);
        const body = Math.abs(candle.close - candle.open);
        return {
            range,
            body,
            bodyRatio: body / range,
            lowerWick: Math.min(candle.open, candle.close) - candle.low,
            upperWick: candle.high - Math.max(candle.open, candle.close)
        };
    }

    function volatilityVeto(candles, config) {
        const minPct = parseFloat(config && config.minVolatilityPct);
        if (!isFinite(minPct) || minPct <= 0) return null;
        const last = candles[candles.length - 1];
        const atr = CoreIndicators.atr(candles, Math.min(14, candles.length - 1));
        if (atr == null || !last.close) return null;
        const pct = (atr / last.close) * 100;
        return pct < minPct ? 'рынок стоит (ATR ' + pct.toFixed(4) + '% < ' + minPct + '%)' : null;
    }

    // Подтверждение продолжения: движение идёт в сторону сигнала и не выдохлось
    function confirmTrendEntry(direction, candles, profile) {
        const last = candles[candles.length - 1];
        const prev = candles[candles.length - 2];
        const parts = candleParts(last);
        const ultra = profile && profile.exp <= 5;
        const minBody = ultra ? 0.28 : 0.2;

        if (parts.bodyRatio < minBody) return 'слабое тело свечи';

        if (direction === 'UP') {
            if (last.close < last.open) return 'свеча закрылась против сигнала';
            if (last.close < prev.close) return 'импульс против сигнала';
        } else {
            if (last.close > last.open) return 'свеча закрылась против сигнала';
            if (last.close > prev.close) return 'импульс против сигнала';
        }

        const closes = candleCloses(candles);
        const ef = CoreIndicators.ema(closes, profile.emaFast);
        const es = CoreIndicators.ema(closes, profile.emaSlow);
        if (ef != null && es != null) {
            if (direction === 'UP' && ef < es) return 'EMA против направления';
            if (direction === 'DOWN' && ef > es) return 'EMA против направления';
        }

        const r = CoreIndicators.rsi(closes, profile.rsiPeriod);
        if (r != null) {
            if (direction === 'UP' && r > (ultra ? 68 : 72)) return 'RSI уже перекуплен';
            if (direction === 'DOWN' && r < (ultra ? 32 : 28)) return 'RSI уже перепродан';
        }
        return null;
    }

    // Подтверждение разворота: цена растянута, движение затухает, есть отбой.
    // Совпадение с трендом здесь НЕ требуется - иначе возвратные сигналы не живут.
    function confirmReversionEntry(direction, candles, profile) {
        const n = candles.length;
        if (n < 4) return 'мало свечей для разворота';
        const last = candles[n - 1];
        const prev = candles[n - 2];
        const parts = candleParts(last);
        const atr = CoreIndicators.atr(candles, Math.min(14, n - 1)) || parts.range;

        // Свеча заметно шире обычного - движение ускоряется, ловить его рано
        if (atr > 0 && parts.range > atr * 2.2) return 'движение ускоряется, разворота нет';

        const lastMove = Math.abs(last.close - prev.close);
        const prevMove = Math.abs(prev.close - candles[n - 3].close);
        const decelerating = lastMove <= prevMove * 1.15;

        const wick = direction === 'UP' ? parts.lowerWick : parts.upperWick;
        const rejection = (wick / parts.range) >= 0.25;

        const turning = direction === 'UP' ? last.close >= last.open : last.close <= last.open;

        const score = (decelerating ? 1 : 0) + (rejection ? 1 : 0) + (turning ? 1 : 0);
        if (score < 2) return 'нет признаков разворота';

        const closes = candleCloses(candles);
        const meanPeriod = Math.min(profile.bbPeriod || 20, n);
        const mean = CoreIndicators.sma(closes, meanPeriod);
        if (mean != null && atr > 0) {
            const price = closes[closes.length - 1];
            if (direction === 'UP' && price > mean) return 'цена выше средней, отскок вверх не обоснован';
            if (direction === 'DOWN' && price < mean) return 'цена ниже средней, отскок вниз не обоснован';
            const stretch = Math.abs(price - mean) / atr;
            const minStretch = parseFloat(profile.minStretch);
            if (stretch < (isFinite(minStretch) ? minStretch : 0.5)) return 'цена не растянута от средней';
        }
        return null;
    }

    // Возвращает { ok, reason, mode }
    function confirmSignalQuality(direction, candles, profile, mode, config) {
        if (!direction || direction === 'NEUTRAL') return { ok: false, reason: 'нет направления', mode: mode };
        if (mode === 'off') return { ok: true, reason: null, mode: mode };
        if (!candles || candles.length < 3) return { ok: false, reason: 'мало закрытых свечей', mode: mode };

        const volReason = volatilityVeto(candles, config);
        if (volReason) return { ok: false, reason: volReason, mode: mode };

        const reason = mode === 'reversion'
            ? confirmReversionEntry(direction, candles, profile)
            : confirmTrendEntry(direction, candles, profile);
        return { ok: !reason, reason: reason, mode: mode };
    }

    function shouldRunSignalEngine() {
        return frameHasTradeUI();
    }

    // ── Higher-timeframe trend filter ──────────────────────────────────
    function getHtfSeconds(expSec) {
        if (expSec <= 5) return 30;     // 30с для ультра-скальпа 3с
        if (expSec <= 30) return 300;   // 5m
        if (expSec <= 180) return 900;  // 15m
        if (expSec <= 300) return 1800; // 30m
        if (expSec <= 1800) return 14400; // 4h
        return 86400;                   // 1d (пока свечей мало, фильтр не блокирует)
    }

    function getHtfContext(ticks, expSec, core, asset) {
        const htfSec = getHtfSeconds(expSec);
        const htfMs = htfSec * 1000;
        const real = core ? getRealCandles(core, asset, htfMs) : null;
        const all = buildCandles(ticks, htfMs, real);
        const nowBucket = Math.floor(Date.now() / htfMs) * htfMs;
        const htfCandles = (all.length && all[all.length - 1].ts >= nowBucket) ? all.slice(0, -1) : all;
        const minCandles = 12;
        if (htfCandles.length < minCandles) {
            return { ready: false, direction: 'NEUTRAL', sec: htfSec, candleCount: htfCandles.length, minRequired: minCandles };
        }
        const closes = candleCloses(htfCandles);
        const ef = CoreIndicators.ema(closes, 9);
        const es = CoreIndicators.ema(closes, 21);
        let direction = 'NEUTRAL';
        if (ef != null && es != null) {
            const spread = Math.abs(ef - es) / es;
            if (spread > 0.0003) direction = ef > es ? 'UP' : 'DOWN';
        }
        return { ready: true, direction, sec: htfSec, candleCount: htfCandles.length, minRequired: minCandles };
    }

    // ── Money Manager ────────────────────────────────────────────────
    // Ставка двигается в момент результата (onResult), а не при следующем сигнале:
    // раньше getNextBet(_lastResult) брал устаревший результат — если следующий сигнал
    // приходил до закрытия прошлой сделки (на 15с/30с почти всегда), шаг мартингейла
    // терялся или применялся дважды. Логика совпадает с mmState в content.js.
    const MM_PATCH_KEYS = ['moneyManagement', 'multiplier', 'maxSteps', 'parlaySteps', 'dalembertUnit', 'labSequence'];
    function mmConfigFrom(c) {
        c = c || {};
        return {
            strategy: c.moneyManagement || 'fixed',
            baseBet: c.baseBet,
            multiplier: c.multiplier || 2,
            maxSteps: c.maxSteps || 5,
            parlaySteps: c.parlaySteps || 2,
            dalembertUnit: c.dalembertUnit || 1,
            labSequence: c.labSequence || '1,2,3'
        };
    }
    const MM_PROGRESSIVE = ['martingale', 'anti_mart', 'fibonacci', 'dalembert', 'oscar', 'parlay', 'labouchere', 'boost'];
    class MoneyManager {
        constructor(c={}) {
            this._fib=[1,1,2,3,5,8,13,21,34,55,89]; this._history=[];
            this.configure(c, true);
        }
        configure(c={}, reset) {
            const prevStrategy = this.strategy;
            this.strategy = c.strategy||'fixed';
            this.baseBet = parseFloat(c.baseBet)||1;
            this.multiplier = parseFloat(c.multiplier)||2;
            this.maxSteps = parseInt(c.maxSteps)||5;
            this.parlaySteps = parseInt(c.parlaySteps)||2;
            this.dalembertUnit = parseFloat(c.dalembertUnit)||1;
            const lab = String(c.labSequence||'1,2,3').split(',').map(n=>parseFloat(String(n).trim())||1);
            this._labInit = lab.length ? lab : [1,2,3];
            if (reset || prevStrategy !== this.strategy) this.resetProgress();
        }
        resetProgress() {
            this._step=0; this._fibIdx=0; this._labSeq=this._labInit.slice();
            this._bet = this.strategy==='labouchere' ? parseFloat((this.baseBet*this._labUnits()).toFixed(2)) : this.baseBet;
        }
        isProgressive() { return MM_PROGRESSIVE.indexOf(this.strategy) >= 0; }
        _labUnits() { const s=this._labSeq||[]; return s.length>=2 ? s[0]+s[s.length-1] : (s[0]||1); }
        /** Ставка на следующую сделку (уже с учётом всех известных результатов). */
        getNextBet() { return this._bet; }
        /** Сдвигает прогрессию по итогу закрытой сделки. DRAW прогрессию не меняет. */
        onResult(r) {
            if (r!=='WIN' && r!=='LOSE') return this._bet;
            const b=this.baseBet;
            const mult=()=>parseFloat((this._bet*this.multiplier).toFixed(2));
            switch(this.strategy) {
                case 'martingale':
                case 'boost':
                    if (r==='LOSE') { this._step++; if (this._step>=this.maxSteps) { this._step=0; this._bet=b; } else this._bet=mult(); }
                    else { this._step=0; this._bet=b; }
                    break;
                case 'anti_mart':
                    if (r==='WIN') { this._step++; if (this._step>=this.maxSteps) { this._step=0; this._bet=b; } else this._bet=mult(); }
                    else { this._step=0; this._bet=b; }
                    break;
                case 'fibonacci':
                    this._fibIdx = r==='LOSE' ? Math.min(this._fibIdx+1,this._fib.length-1) : Math.max(0,this._fibIdx-2);
                    this._step=this._fibIdx;
                    this._bet=parseFloat((b*this._fib[this._fibIdx]).toFixed(2));
                    break;
                case 'dalembert':
                    if (r==='LOSE') { this._step++; this._bet=parseFloat((this._bet+this.dalembertUnit).toFixed(2)); }
                    else { this._step=Math.max(0,this._step-1); this._bet=Math.max(b,parseFloat((this._bet-this.dalembertUnit).toFixed(2))); }
                    break;
                case 'oscar':
                    if (r==='WIN') { this._step++; this._bet=parseFloat((this._bet+this.dalembertUnit).toFixed(2)); }
                    break;
                case 'parlay':
                    if (r==='WIN') { this._step++; if (this._step>=this.parlaySteps) { this._step=0; this._bet=b; } else this._bet=parseFloat((this._bet*1.85).toFixed(2)); }
                    else { this._step=0; this._bet=b; }
                    break;
                case 'labouchere': {
                    const cur=this._labUnits();
                    if (r==='WIN') { if (this._labSeq.length>=2) { this._labSeq.shift(); this._labSeq.pop(); } else this._labSeq=[]; }
                    else this._labSeq.push(cur);
                    if (!this._labSeq.length) this._labSeq=this._labInit.slice();
                    this._step=this._labSeq.length;
                    this._bet=parseFloat((b*this._labUnits()).toFixed(2));
                    break;
                }
                default: this._step=0; this._bet=b;
            }
            return this._bet;
        }
        recordResult(r,p) { this._history.push({bet:this._bet,result:r,profit:p,time:Date.now()}); }
        getStats() {
            const w=this._history.filter(t=>t.result==='WIN').length;
            const l=this._history.filter(t=>t.result==='LOSE').length;
            const tot=w+l;
            return { wins:w,losses:l,total:tot,winRate:tot>0?((w/tot)*100).toFixed(1):0,totalProfit:this._history.reduce((a,t)=>a+t.profit,0).toFixed(2),currentBet:this._bet };
        }
        reset() { this.resetProgress(); this._history=[]; }
    }

    // ── AUTO-TRADE (DOM helpers) ───────────────────────────────────────
    function parseNumLoose(raw) {
        if (raw == null) return null;
        let s = String(raw).trim();
        if (!s || s === '*******' || /^\*+$/.test(s.replace(/\s/g, ''))) return null;
        // "1 234,56" / "1,234.56" / "1234.56"
        s = s.replace(/\s/g, '');
        if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
        else if (/^\d{1,3}(\.\d{3})+(,\d+)$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
        else s = s.replace(/[^\d.,\-]/g, '').replace(',', '.');
        const n = parseFloat(s);
        return !isNaN(n) && isFinite(n) && n >= 0 ? n : null;
    }

    function isHdHidden(el) {
        if (!el) return true;
        const st = (el.getAttribute('data-hd-status') || '').toLowerCase();
        if (st === 'hide' || st === 'hidden' || st === '0' || st === 'off') return true;
        let p = el;
        for (let i = 0; i < 8 && p; i++) {
            const cls = (p.className || '').toString();
            if (/\b(hide|hidden|d-none|is-hidden|hd-hide)\b/i.test(cls)) return true;
            if (p.getAttribute && p.getAttribute('aria-hidden') === 'true') return true;
            p = p.parentElement;
        }
        return !isVisible(el);
    }

    function parseBalanceEl(el) {
        if (!el) return null;
        const txtRaw = (el.textContent || '').trim();
        const masked = !txtRaw || txtRaw === '*******' || /^\*+$/.test(txtRaw.replace(/\s/g, ''));
        const fromText = masked ? null : parseNumLoose(txtRaw);

        const attrs = [
            el.getAttribute('data-hd-show'),
            el.getAttribute('data-hd-value'),
            el.getAttribute('data-balance'),
            el.getAttribute('data-value'),
            el.getAttribute('title'),
            el.dataset ? el.dataset.hdShow : null,
            el.dataset ? el.dataset.balance : null
        ];
        let fromAttr = null;
        for (let i = 0; i < attrs.length; i++) {
            const n = parseNumLoose(attrs[i]);
            if (n != null) { fromAttr = n; break; }
        }

        // Если текст и атрибут расходятся - для видимого элемента берём текст (он живой)
        if (fromText != null && fromAttr != null && Math.abs(fromText - fromAttr) >= 0.01) {
            return fromText;
        }
        if (fromText != null) return fromText;
        return fromAttr;
    }

    function scoreBalanceEl(el) {
        if (!el) return -1;
        if (isHdHidden(el)) return -100;
        let score = 0;
        if (isVisible(el)) score += 20;
        if (el.closest('.balance-info__button, .header-balance, .balance-info__wrap, .js-header, header, .current-account')) score += 15;
        if (el.closest('.block--bet-amount, .trading-panel')) score += 8;
        if (el.closest('.accounts-list, .dropdown, .dops, [class*="dropdown"], [class*="drop-down"]')) score -= 10;
        const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        if (r && r.top >= 0 && r.top < 140) score += 8;
        // Штраф за устаревший атрибут при другом тексте
        const txt = parseNumLoose((el.textContent || '').trim());
        const attr = parseNumLoose(el.getAttribute('data-hd-show'));
        if (txt != null && attr != null && Math.abs(txt - attr) >= 0.01) score += 5;
        return score;
    }

    function readBestBalance(selectors) {
        const sel = Array.isArray(selectors) ? selectors.join(',') : selectors;
        let bestVal = null;
        let bestScore = -1;
        let bestEl = null;
        try {
            document.querySelectorAll(sel).forEach(function(el) {
                const v = parseBalanceEl(el);
                if (v == null) return;
                const sc = scoreBalanceEl(el);
                if (sc < 0) return;
                if (sc > bestScore) {
                    bestScore = sc;
                    bestVal = v;
                    bestEl = el;
                }
            });
        } catch (_) {}
        return { value: bestVal, el: bestEl, score: bestScore };
    }

    function readPlatformBalances() {
        const demo = readBestBalance([
            '.js-balance-demo',
            '.js-hd.js-balance-demo',
            '[class*="js-balance-demo"]',
            '[class*="balance-demo"]'
        ]);
        const real = readBestBalance([
            '.js-balance-real-USD',
            '.js-hd.js-balance-real-USD',
            '.js-balance-real',
            '[class*="js-balance-real"]',
            '[class*="balance-real"]'
        ]);
        return {
            demo: demo.value,
            real: real.value,
            demoScore: demo.score,
            realScore: real.score
        };
    }

    function readTradingPanelBalance() {
        const found = readBestBalance([
            '.block--bet-amount .balance__value',
            '.block--bet-amount .value__val',
            '.trading-panel .balance__value',
            '.right-block .balance__value',
            '.balance-info__value',
            '.balance-info .value__val',
            '.header-balance__value',
            '.balance-widget__value',
            '.js-balance-demo',
            '.js-balance-real-USD'
        ]);
        return found.value;
    }

    function isBalanceSpanActive(el) {
        if (!el) return false;
        let p = el;
        for (let i = 0; i < 14 && p; i++) {
            const cls = (p.className || '').toString();
            if (/active|selected|current|checked|is-active|is-selected|is-current/.test(cls)) return true;
            const aria = p.getAttribute('aria-selected') || p.getAttribute('aria-current') || p.getAttribute('aria-pressed');
            if (aria === 'true') return true;
            if (p.getAttribute('data-active') === 'true' || p.getAttribute('data-selected') === 'true') return true;
            p = p.parentElement;
        }
        return false;
    }

    function isVisible(el) {
        if (!el || typeof el.getBoundingClientRect !== 'function') return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const st = getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity || '1') > 0.01;
    }

    function balancesClose(a, b) {
        return a != null && b != null && Math.abs(a - b) < 0.02;
    }

    function readActiveBalanceFromHeaderButton() {
        const buttonSelectors = [
            '.balance-info__button',
            '.balance-info__wrap',
            '.header-balance__current',
            '.header-balance__value-wrap',
            '.balance-current',
            '.js-current-account',
            '.balance-info:not(.balance-info--dropdown)',
            '.header__balance',
            '.top-header .balance-info'
        ];
        for (let i = 0; i < buttonSelectors.length; i++) {
            const btn = document.querySelector(buttonSelectors[i]);
            if (!btn || !isVisible(btn)) continue;
            const realIn = btn.querySelector('.js-balance-real-USD, .js-hd.js-balance-real-USD, .js-balance-real');
            const demoIn = btn.querySelector('.js-balance-demo, .js-hd.js-balance-demo');
            // Берём только реально показанный в кнопке счёт
            if (realIn && !isHdHidden(realIn)) {
                const bal = parseBalanceEl(realIn);
                if (bal != null) return { type: 'real', balance: bal };
            }
            if (demoIn && !isHdHidden(demoIn)) {
                const bal = parseBalanceEl(demoIn);
                if (bal != null) return { type: 'demo', balance: bal };
            }
            // Fallback: любой видимый числовой span в кнопке
            const spans = btn.querySelectorAll('.js-hd, [class*="balance"]');
            for (let j = 0; j < spans.length; j++) {
                if (isHdHidden(spans[j])) continue;
                const bal = parseBalanceEl(spans[j]);
                if (bal == null) continue;
                const cls = (spans[j].className || '').toString();
                const type = /demo/i.test(cls) ? 'demo' : (/real/i.test(cls) ? 'real' : null);
                return { type: type, balance: bal };
            }
        }
        return null;
    }

    function readTopVisibleBalanceSpan() {
        const candidates = [];
            document.querySelectorAll('.js-balance-demo, .js-hd.js-balance-demo').forEach(function(el) {
            if (isHdHidden(el)) return;
            const p = el.closest('.accounts-list, .dropdown, .dops, [class*="dropdown"], [class*="accounts-list"]');
            if (p && isHdHidden(p)) return;
            candidates.push({
                type: 'demo',
                balance: parseBalanceEl(el),
                top: el.getBoundingClientRect().top
            });
        });
        document.querySelectorAll('.js-balance-real-USD, .js-hd.js-balance-real-USD, .js-balance-real').forEach(function(el) {
            if (isHdHidden(el)) return;
            const p = el.closest('.accounts-list, .dropdown, .dops, [class*="dropdown"], [class*="accounts-list"]');
            if (p && isHdHidden(p)) return;
            candidates.push({
                type: 'real',
                balance: parseBalanceEl(el),
                top: el.getBoundingClientRect().top
            });
        });
        if (!candidates.length) return null;
        candidates.sort(function(a, b) { return a.top - b.top; });
        return candidates[0];
    }

    function inferTypeFromBalanceValue(activeBal, bal) {
        if (activeBal == null) return null;
        const demoMatch = balancesClose(activeBal, bal.demo);
        const realMatch = balancesClose(activeBal, bal.real);
        if (realMatch && !demoMatch) return 'real';
        if (demoMatch && !realMatch) return 'demo';
        if (realMatch && demoMatch) return null;
        return null;
    }

    function detectActiveAccountType(balances) {
        const bal = balances || readPlatformBalances();

        const headerBtn = readActiveBalanceFromHeaderButton();
        if (headerBtn && headerBtn.type) return headerBtn.type;

        const topSpan = readTopVisibleBalanceSpan();
        if (topSpan && topSpan.type) return topSpan.type;

        const activeSelectors = [
            '.accounts-list__item--demo.active',
            '.accounts-list__item--demo.is-active',
            '.accounts-list__item--demo.selected',
            '.balance-type-demo.active',
            '[data-account-type="demo"].active',
            '.switcher__btn--demo.active',
            '.header-balance__item--demo.active',
            '.header-balance__item--demo.is-active',
            '.balance-info--demo.active',
            '.balance-info--demo.is-active',
            '.js-switch-to-demo.active',
            'a[class*="demo"].active',
            'button[class*="demo"].active'
        ];
        for (let i = 0; i < activeSelectors.length; i++) {
            if (document.querySelector(activeSelectors[i])) return 'demo';
        }
        const realSelectors = [
            '.accounts-list__item--real.active',
            '.accounts-list__item--real.is-active',
            '.accounts-list__item--real.selected',
            '[data-account-type="real"].active',
            '.switcher__btn--real.active',
            '.header-balance__item--real.active',
            '.header-balance__item--real.is-active',
            '.balance-info--real.active',
            '.balance-info--real.is-active',
            'a[class*="real"].active',
            'button[class*="real"].active'
        ];
        for (let i = 0; i < realSelectors.length; i++) {
            if (document.querySelector(realSelectors[i])) return 'real';
        }

        const demoEl = document.querySelector('.js-balance-demo, .js-hd.js-balance-demo');
        const realEl = document.querySelector('.js-balance-real-USD, .js-hd.js-balance-real-USD, .js-balance-real');
        const demoActive = isBalanceSpanActive(demoEl);
        const realActive = isBalanceSpanActive(realEl);
        if (demoActive && !realActive) return 'demo';
        if (realActive && !demoActive) return 'real';

        const panelBal = readTradingPanelBalance();
        if (panelBal != null) {
            const inferred = inferTypeFromBalanceValue(panelBal, bal);
            if (inferred) return inferred;
        }

        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i) || '';
                if (!/demo|account|balance/i.test(key)) continue;
                const val = (localStorage.getItem(key) || '').toLowerCase();
                if (val === 'real' || val === 'live') return 'real';
                if (val === 'demo' || val === '1' || val === 'true') return 'demo';
            }
        } catch (_) {}

        if (bal.demo != null && bal.real == null) return 'demo';
        if (bal.real != null && bal.demo == null) return 'real';
        return 'demo';
    }

    function getActiveBalanceInfo() {
        const balances = readPlatformBalances();
        const headerBtn = readActiveBalanceFromHeaderButton();
        const topSpan = readTopVisibleBalanceSpan();

        let type = null;
        let balance = null;

        // Абсолютный приоритет: то, что пользователь видит в шапке сайта
        if (headerBtn && headerBtn.balance != null) {
            balance = headerBtn.balance;
            type = headerBtn.type || detectActiveAccountType(balances);
        } else if (topSpan && topSpan.balance != null) {
            balance = topSpan.balance;
            type = topSpan.type || detectActiveAccountType(balances);
        } else {
            type = detectActiveAccountType(balances);
            balance = type === 'real' ? balances.real : balances.demo;
            if (balance == null) balance = readTradingPanelBalance();
            if (balance == null) balance = balances.demo != null ? balances.demo : balances.real;
        }

        if (!type) type = detectActiveAccountType(balances);

        // Синхронизируем кэш активного счёта с тем, что видно
        let demo = balances.demo;
        let real = balances.real;
        if (type === 'demo' && balance != null) demo = balance;
        if (type === 'real' && balance != null) real = balance;

        return { type: type || 'demo', balance, demo, real };
    }

    function hasBalanceContext() {
        return !!(document.querySelector('.js-balance-demo, .js-hd.js-balance-demo, .js-balance-real-USD, .js-hd.js-balance-real-USD, .balance-info, .header-balance, .block--bet-amount') ||
            readTradingPanelBalance() != null);
    }

    function shouldPostBalance() {
        return !!(document.querySelector('.js-balance-demo, .js-hd.js-balance-demo') ||
            document.querySelector('.js-balance-real-USD, .js-hd.js-balance-real-USD, .js-balance-real') ||
            document.querySelector('.balance-info__button, .header-balance, .block--bet-amount'));
    }

    function capBetToBalance(amount) {
        const amt = parseFloat(amount);
        if (!isFinite(amt) || amt <= 0) return 1;
        const info = getActiveBalanceInfo();
        if (info.balance == null) return parseFloat(amt.toFixed(2));
        return parseFloat(Math.min(amt, info.balance).toFixed(2));
    }

    function setInputValue(inp, value) {
        const str = String(value);
        inp.focus();
        try {
            const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
            if (desc && desc.set) desc.set.call(inp, str);
            else inp.value = str;
        } catch (_) {
            inp.value = str;
        }
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    function findBetInput() {
        const selectors = [
            '.value__val input[type="text"]',
            '.value__val input',
            '.control__value input[type="text"]',
            '.control__value input',
            '.block__control.control input[type="text"]',
            '.block__control input',
            'input[inputmode="decimal"]',
            '.bet-input',
            'input[class*="bet"]',
            'input[class*="amount"]'
        ];
        for (const sel of selectors) {
            const inp = document.querySelector(sel);
            if (inp && inp.offsetParent !== null) return inp;
        }
        return null;
    }

    function formatBetAmount(amount) {
        const n = parseFloat(amount);
        if (!isFinite(n) || n <= 0) return '1';
        if (Number.isInteger(n)) return String(n);
        return n.toFixed(2).replace(/\.?0+$/, '');
    }

    function setBetAmount(amount) {
        const inp = findBetInput();
        if (!inp) return false;
        try {
            setInputValue(inp, formatBetAmount(capBetToBalance(amount)));
            return true;
        } catch (_) {
            return false;
        }
    }

    async function applyPlatformBetAmount(amount, attempts) {
        const amt = capBetToBalance(amount);
        if (!isFinite(amt) || amt <= 0) return false;
        const tries = attempts || 5;
        for (let i = 0; i < tries; i++) {
            if (setBetAmount(amt)) return true;
            await sleep(80 + i * 40);
        }
        return false;
    }

    function sleep(ms) {
        return new Promise(function(resolve) { setTimeout(resolve, ms); });
    }

    // Таймфреймы, которые есть в списке PocketOption (.dops__timeframes-item):
    // S3, S15, S30, M1, M3, M5, M30, H1, H4. M2 у PO нет.
    const PO_TIMEFRAMES = { S3: 3, S15: 15, S30: 30, M1: 60, M3: 180, M5: 300, M30: 1800, H1: 3600, H4: 14400 };

    function getExpirationLabels(sec) {
        const map = {
            3:     ['S3', '3S', '00:00:03', '0:00:03', '3SEC', '3С'],
            15:    ['S15', '15S', '00:00:15', '0:00:15', '15SEC'],
            30:    ['S30', '30S', '00:00:30', '0:00:30', '30SEC'],
            60:    ['M1', '1M', '00:01:00', '01:00', '1MIN'],
            180:   ['M3', '3M', '00:03:00', '03:00', '3MIN'],
            300:   ['M5', '5M', '00:05:00', '05:00', '5MIN'],
            1800:  ['M30', '30M', '00:30:00', '30:00', '30MIN'],
            3600:  ['H1', '1H', '01:00:00', '1:00:00', '60MIN'],
            14400: ['H4', '4H', '04:00:00', '4:00:00']
        };
        return (map[sec] || [String(sec)]).slice().sort(function(a, b) { return b.length - a.length; });
    }

    function normExpLabel(txt) {
        return (txt || '').trim().toUpperCase().replace(/\s+/g, '');
    }

    function isExpirationItemActive(el) {
        if (!el) return false;
        const cls = (el.className || '').toString().toLowerCase();
        if (/active|selected|current|checked/.test(cls)) return true;
        if (el.getAttribute('aria-selected') === 'true') return true;
        if (el.getAttribute('aria-current') === 'true') return true;
        return false;
    }

    // exact=true — только точное совпадение текста. Подстрока опасна: «S3» входит в «S30», «M3» — в «M30».
    function labelMatchesExpiration(el, targets, exact) {
        const chunks = [
            el.textContent,
            el.innerText,
            el.getAttribute('data-time'),
            el.getAttribute('data-value'),
            el.getAttribute('data-period'),
            el.getAttribute('title')
        ];
        for (let i = 0; i < chunks.length; i++) {
            const txt = normExpLabel(chunks[i]);
            if (!txt) continue;
            for (let j = 0; j < targets.length; j++) {
                const t = normExpLabel(targets[j]);
                if (!t) continue;
                if (txt === t) return true;
                if (!exact && t.length >= 2 && txt.indexOf(t) >= 0) return true;
            }
        }
        return false;
    }

    function clickExpirationEl(el) {
        if (!el || el.offsetParent === null) return false;
        try {
            el.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'instant' });
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            el.click();
            return true;
        } catch (_) {
            return false;
        }
    }

    function parseExpirationDisplay(text) {
        const t = (text || '').trim();
        if (!t) return null;
        const parts = t.split(':').map(function(p) { return parseInt(p, 10); });
        if (parts.some(function(n) { return isNaN(n); })) return null;
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        return null;
    }

    function getExpirationDisplayEl() {
        return document.querySelector('.block--expiration-inputs .value__val')
            || document.querySelector('.block--expiration-inputs .control__value .value__val');
    }

    function readPlatformExpirationSeconds() {
        const displayEl = getExpirationDisplayEl();
        if (displayEl) {
            const fromDisplay = parseExpirationDisplay(displayEl.textContent);
            if (fromDisplay != null) return fromDisplay;
        }
        const active = document.querySelector('.dops__timeframes-item--active, .dops__timeframes-item.active');
        if (active) {
            const key = normExpLabel(active.textContent);
            if (PO_TIMEFRAMES[key] != null) return PO_TIMEFRAMES[key];
        }
        return null;
    }

    function expirationAlreadySet(sec, targets) {
        const current = readPlatformExpirationSeconds();
        // Время на PO прочитано — верим только ему (по подстроке «30» совпадало и с 00:30:00)
        if (current != null) return current === sec;
        const displayEl = getExpirationDisplayEl();
        return !!(displayEl && labelMatchesExpiration(displayEl, targets, true));
    }

    function isExpirationDropdownOpen() {
        const modal = document.querySelector('.trading-panel-modal__dops .dops__timeframes, .dops__timeframes');
        if (modal && modal.offsetParent !== null) return true;
        const items = document.querySelectorAll('.dops__timeframes-item');
        for (let i = 0; i < items.length; i++) {
            if (items[i].offsetParent !== null) return true;
        }
        return false;
    }

    function openExpirationDropdown() {
        const triggers = [
            '.block--expiration-inputs .control__value.value',
            '.block--expiration-inputs .control__value',
            '.block--expiration-inputs .value__val',
            '.block--expiration-inputs'
        ];
        for (let i = 0; i < triggers.length; i++) {
            const el = document.querySelector(triggers[i]);
            if (el && el.offsetParent !== null && clickExpirationEl(el)) return true;
        }
        return false;
    }

    function findExpirationItems() {
        return document.querySelectorAll('.trading-panel-modal__dops .dops__timeframes-item, .dops__timeframes .dops__timeframes-item, .dops__timeframes-item');
    }

    function clickExpirationItem(sec, targets) {
        const items = findExpirationItems();
        let fallback = null;
        // Сначала точное совпадение (S3 ≠ S30, M3 ≠ M30), подстрока — только если точного нет
        for (let pass = 0; pass < 2; pass++) {
            for (let i = 0; i < items.length; i++) {
                const el = items[i];
                if (!labelMatchesExpiration(el, targets, pass === 0)) continue;
                if (isExpirationItemActive(el) && expirationAlreadySet(sec, targets)) return true;
                if (!fallback) fallback = el;
                if (clickExpirationEl(el)) return true;
            }
            if (fallback) break;
        }
        return fallback ? clickExpirationEl(fallback) : false;
    }

    async function setPlatformExpirationAsync(seconds) {
        const sec = parseInt(seconds, 10);
        if (!sec || sec <= 0) return false;

        const targets = getExpirationLabels(sec);
        if (expirationAlreadySet(sec, targets)) return true;

        if (!isExpirationDropdownOpen()) {
            openExpirationDropdown();
            await sleep(140);
        }

        if (clickExpirationItem(sec, targets)) {
            await sleep(120);
            if (expirationAlreadySet(sec, targets)) return true;
        }

        openExpirationDropdown();
        await sleep(160);
        if (clickExpirationItem(sec, targets)) {
            await sleep(120);
            return expirationAlreadySet(sec, targets);
        }

        return false;
    }

    function setPlatformExpiration(seconds) {
        const sec = parseInt(seconds, 10);
        if (!sec || sec <= 0) return false;
        const targets = getExpirationLabels(sec);
        if (expirationAlreadySet(sec, targets)) return true;

        if (!isExpirationDropdownOpen()) openExpirationDropdown();
        if (clickExpirationItem(sec, targets)) {
            return expirationAlreadySet(sec, targets);
        }
        return false;
    }

    function frameHasTradeUI() {
        return !!document.querySelector('.block--expiration-inputs, .dops__timeframes-item, a.btn.btn-call, a.btn.btn-put, .btn-call, .btn-put, .value__val input, .control__value input');
    }

    async function applyPlatformExpiration(seconds, attempts) {
        const sec = parseInt(seconds, 10);
        if (!sec || sec <= 0) return false;
        const tries = attempts || 5;
        for (let i = 0; i < tries; i++) {
            if (await setPlatformExpirationAsync(sec)) return true;
            await sleep(100 + i * 60);
        }
        return false;
    }

    async function executeTrade(direction, amount, expirationSec) {
        const core = window.__poCore;
        const exp = core && core.config && core.config.expiration != null
            ? parseInt(core.config.expiration, 10)
            : parseInt(expirationSec, 10);

        const betOk = await applyPlatformBetAmount(amount);
        await sleep(60);

        const expOk = await applyPlatformExpiration(exp || 60);
        await sleep(150);

        const tradeOk = clickTradeButton(direction);
        return tradeOk && expOk && betOk;
    }

    function clickTradeButton(direction) {
        const isUp = direction === 'UP';
        // Pocket Option: UP/CALL = «Купить» (.btn-call), DOWN/PUT = «Продать» (.btn-put)
        const selectors = isUp
            ? ['a.btn.btn-call', '.btn.btn-call', 'a.btn-call', '.btn-call', '[data-test="call-button"]', '[data-x-test="up"]']
            : ['a.btn.btn-put', '.btn.btn-put', 'a.btn-put', '.btn-put', '[data-test="put-button"]', '[data-x-test="down"]'];
        for (const sel of selectors) {
            const btn = document.querySelector(sel);
            if (btn && btn.offsetParent !== null && !btn.classList.contains('disabled') && btn.getAttribute('aria-disabled') !== 'true') {
                btn.click();
                return true;
            }
        }
        // Fallback: find by visible label text
        const label = isUp ? 'Купить' : 'Продать';
        const altLabel = isUp ? 'Buy' : 'Sell';
        const links = document.querySelectorAll('a.btn, .btn');
        for (const el of links) {
            const txt = (el.textContent || '').trim();
            if ((txt.includes(label) || txt.includes(altLabel)) && el.offsetParent !== null) {
                el.click();
                return true;
            }
        }
        return false;
    }

    // ── Quotex Core Engine ───────────────────────────────────────────
    class QuotexCore {
        constructor() {
            this.isRunning=false; this.config=null;
            this.money=new MoneyManager();
            this._prices={}; this._ticks={}; this._ohlc={}; this._sentiment={};
            this._lastAsset=null; this._domAsset=null; this._wsAsset=null;
            this._domChangedAt=0; this._priceTickTs={};
            this._lastResult=null;
            this._lastResultAt=0;
            this._lastSignal=null; this._lastSignalTime=0;
            this._tradeBusy=false;
            this._tradeBusySince=0;
            this._indFireTime={};
            this._lastRejectKey=''; this._lastRejectAt=0; this._ohlcLogged=false;
            this._lastEntryBar=0;
            this._loopTimer=null; this._resultObserver=null;
            this._reverseWinCount=0;
            this._reverseMode=false;
        }

        _hasTerminal() {
            // Quotex DOM selectors
            return !!(
                document.querySelector('.trading-panel, .chart-area, [class*="trading"], [class*="chart-container"]')
            );
        }

        _post(type, payload) {
            try { window.postMessage({ type, ...payload }, '*'); } catch(_) {}
        }

        log(msg) {
            if (!isPrimarySignalFrame()) return;
            const t=new Date().toLocaleTimeString();
            const text=`[${t}] ${msg}`;
            console.log(`[PocketOption Signal][CORE] ${text}`);
            this._post('POROBOT_LOG', { message: text });
        }

        start(config) {
            this.config = config||{};
            this._reverseWinCount = 0;
            this._reverseMode = false;
            this.money = new MoneyManager(mmConfigFrom(this.config));
            this._lastResult=null; this._lastSignal=null; this._lastSignalTime=0;
            this._lastResultAt=0; this._resultIds=new Set(); this._pendingTrades=[]; this._wsResultSeen=false;
            this._awaitLoggedAt=0;
            this._tradeBusy=false;
            this._tradeBusySince=0;
            this._indFireTime={};
            this._lastEntryBar=0;
            this._mixedAllLogged=false;
            this._firstPriceLogged = false; this._wsMismatchLogged = false;
            this._domChangedAt = 0; this._priceTickTs = {};

            if (!claimPrimaryEngine()) {
                this.isRunning = false;
                return;
            }

            this.isRunning=true;
            if(this._loopTimer) clearInterval(this._loopTimer);
            if(this._domTimer) clearInterval(this._domTimer);
            this._loopTimer=setInterval(()=>this._scan(),1500);
            this._syncAssetFromDOM(true);
            this._domTimer=setInterval(()=>this._syncAssetFromDOM(), 800);
            this._watchResults();
            if (this.config?.multiPairTrading) this._startMultiPairTrading();
            const exp = parseInt(this.config?.expiration, 10) || 60;
            const prof = getAnalysisProfile(exp, this._analysisTimeframeSeconds());
            const bet = capBetToBalance(parseFloat(this.config?.baseBet) || 1);
            this._lastAppliedExp = readPlatformExpirationSeconds();
            this._lastAppliedBet = bet;
            const self = this;
            Promise.all([
                applyPlatformExpiration(exp, 5),
                applyPlatformBetAmount(bet, 5)
            ]).then(function(results) {
                const expOk = results[0];
                const betOk = results[1];
                if (expOk) self._lastAppliedExp = exp;
                if (betOk) self._lastAppliedBet = bet;
                let note = '';
                if (!expOk) note += ' | ⚠️ exp sync';
                if (!betOk) note += ' | ⚠️ bet sync';
                const inds = self._indicatorList().join('+') || (self.config.indicator || 'RSI');
                const fm = String(self.config.filterMode || 'ALL').toUpperCase();
                const cm = getConfirmMode(self.config);
                self.log('🤖 Запущен | ' + inds + ' | ' + fm + ' | подтв:' + cm + ' | MM:' + (self.config.moneyManagement || 'fixed') + ' | $' + bet + ' | Exp:' + exp + 's | Свечи:' + prof.candleSec + 's' + note);
                self._maybeRequestHistory(true);
                if (self._domAsset) subscribeSentiment(self._domAsset);
                if (self.config.chartOverlay) {
                    try { PosChartOverlay.setEnabled(true, self.config); } catch (_) {}
                }
            });
        }

        _analysisTimeframeSeconds() {
            const configured = parseInt(this.config?.analysisTimeframeSeconds, 10);
            if (isFinite(configured) && configured >= 3) return configured;
            const chartPeriod = parseInt(window.__poChartPeriodSec, 10);
            if (isFinite(chartPeriod) && chartPeriod >= 3) return chartPeriod;
            return parseInt(this.config?.expiration, 10) || 60;
        }

        _maybeRequestHistory(force) {
            const asset = this._wsAsset || this._domAsset;
            if (!asset) return;
            const exp = parseInt(this.config?.expiration, 10) || 60;
            const profile = getAnalysisProfile(exp, this._analysisTimeframeSeconds());
            const ctx = this._getAnalysisContext(asset);
            if (ctx.ready && !force) return;
            const now = Date.now();
            if (!force && this._historyReqAt && (now - this._historyReqAt) < 25000) return;
            this._historyReqAt = now;
            const ok = requestAssetHistory(asset, profile.candleSec);
            if (ok) {
                this.log('📥 Запрос прошлых свечей у PO (' + toPoAssetId(asset) + ', свечи ' + profile.candleSec + 's; экспирация ' + exp + 's)...');
            }
        }

        _syncAssetFromDOM(forceLog) {
            const a = readCurrentAssetFromDOM();
            if (!a || a === 'UNKNOWN') return;
            const norm = normalizeAssetName(a);
            if (!looksLikeAsset(norm)) return;
            const prev = this._domAsset;
            this._domAsset = norm;
            if (!prev || !assetsMatch(prev, norm)) {
                this._lastSignal = null;
                this._lastSignalTime = 0;
                this._indFireTime = {};
                this._wsMismatchLogged = false;
                this._staleStreamLogged = false;
                this._firstPriceLogged = false;
                this._lastRejectKey = '';
                this._lastRejectAt = 0;
                this._lastEntryBar = 0;
                this._domChangedAt = Date.now();
                this._wsAsset = null;
                this.log('🔄 Пара: ' + (prev || '-') + ' -> ' + norm);
                const keys = Object.keys(this._ticks).concat(Object.keys(this._prices));
                const uniqKeys = keys.filter(function(k, i, a) { return a.indexOf(k) === i; });
                const ws = resolveWsAssetForDom(norm, uniqKeys);
                if (ws && uniqKeys.length && assetsMatch(ws, norm)) {
                    this._wsAsset = ws;
                    learnAssetAlias(norm, ws);
                    this.log('📈 WS синхронизирован: ' + ws + ' ↔ ' + norm);
                } else {
                    this.log('⏳ Жду поток WS: ' + formatExpectedWs(norm));
                }
                this._post('POROBOT_ASSET', { asset: norm, wsAsset: this._wsAsset || ws || norm });
                this._historyReqAt = 0;
                this._maybeRequestHistory(true);
                subscribeSentiment(norm);
            } else if (forceLog) {
                this.log('📌 Текущая пара: ' + norm);
            }
        }

        _matchingPriceKeys(domAsset) {
            if (!domAsset) return [];
            const set = new Set();
            const allKeys = Object.keys(this._prices).concat(Object.keys(this._ticks));
            for (let i = 0; i < allKeys.length; i++) {
                const k = allKeys[i];
                if (assetsMatch(k, domAsset)) set.add(k);
            }
            return Array.from(set);
        }

        _newestMatchingAsset(domAsset, minCount) {
            const keys = this._matchingPriceKeys(domAsset);
            let best = null, bestTs = 0, bestCount = 0;
            for (const k of keys) {
                const count = this._prices[k]?.length || 0;
                if (count < (minCount || 1)) continue;
                const ts = this._priceTickTs[k] || 0;
                if (ts > bestTs || (ts === bestTs && count > bestCount)) {
                    bestTs = ts;
                    bestCount = count;
                    best = k;
                }
            }
            return best;
        }

        _bestPriceAsset(minCount) {
            let best = null, max = 0;
            for (const key of Object.keys(this._prices)) {
                const n = this._prices[key]?.length || 0;
                if (n > max) { max = n; best = key; }
            }
            return (max >= (minCount || 1)) ? best : null;
        }

        _resolveScanAsset() {
            this._syncAssetFromDOM();
            const exp = parseInt(this.config?.expiration, 10) || 60;
            const profile = getAnalysisProfile(exp, this._analysisTimeframeSeconds());
            const minTicks = Math.max(40, profile.minCandles * 4);
            const dom = this._domAsset;
            const tickKeys = Object.keys(this._ticks);
            const priceKeys = Object.keys(this._prices);
            const keys = tickKeys.length ? tickKeys : priceKeys;

            if (dom) {
                const matched = this._newestMatchingAssetFromTicks(dom, minTicks);
                if (matched) {
                    this._wsAsset = matched;
                    return matched;
                }
                const predicted = resolveWsAssetForDom(dom, keys);
                if (predicted) {
                    const ticks = this._getTicksForAsset(predicted);
                    if (ticks.length >= minTicks || (this._prices[predicted]?.length || 0) >= minTicks) {
                        this._wsAsset = predicted;
                        learnAssetAlias(dom, predicted);
                        return predicted;
                    }
                }
                if (this._domChangedAt && Date.now() - this._domChangedAt < 8000) {
                    return null;
                }
            }

            const ws = this._wsAsset;
            if (ws && dom && assetsMatch(ws, dom)) {
                const ticks = this._getTicksForAsset(ws);
                if (ticks.length >= minTicks || (this._prices[ws]?.length || 0) >= minTicks) return ws;
            }

            if (dom) {
                if (!this._wsMismatchLogged) {
                    this._wsMismatchLogged = true;
                    this.log('⚠️ WS для ' + dom + ' не найден - жду ' + formatExpectedWs(dom));
                }
                return null;
            }

            const best = this._bestTickAsset(minTicks);
            if (best) return best;
            return ws || null;
        }

        _newestMatchingAssetFromTicks(domAsset, minCount) {
            const keys = this._matchingPriceKeys(domAsset);
            let best = null, bestTs = 0, bestCount = 0;
            for (const k of keys) {
                const count = this._getTicksForAsset(k).length || this._prices[k]?.length || 0;
                if (count < (minCount || 1)) continue;
                const ts = this._priceTickTs[k] || 0;
                if (ts > bestTs || (ts === bestTs && count > bestCount)) {
                    bestTs = ts;
                    bestCount = count;
                    best = k;
                }
            }
            return best;
        }

        _bestTickAsset(minCount) {
            let best = null, max = 0;
            const allKeys = Object.keys(this._ticks).length ? Object.keys(this._ticks) : Object.keys(this._prices);
            for (const key of allKeys) {
                const n = this._getTicksForAsset(key).length || this._prices[key]?.length || 0;
                if (n > max) { max = n; best = key; }
            }
            return (max >= (minCount || 1)) ? best : null;
        }

        _getTicksForAsset(asset) {
            if (!asset) return [];
            const direct = this._ticks[asset];
            if (direct && direct.length) return direct;
            for (const key of Object.keys(this._ticks)) {
                if (assetsMatch(key, asset)) return this._ticks[key] || [];
            }
            const legacy = this._getPricesForAsset(asset);
            if (!legacy.length) return [];
            return legacy.map(function(p, i) { return { price: p, ts: Date.now() - (legacy.length - i) * 1000 }; });
        }

        _indicatorList() {
            const raw = this.config?.indicators;
            return (Array.isArray(raw) && raw.length > 0) ? raw : [this.config?.indicator || 'RSI'];
        }

        // Прогрев считаем по фактически выбранным индикаторам, а не по всему набору:
        // иначе MACD навязывает 37 свечей даже там, где он не используется.
        _requiredCandles(profile, list) {
            const self = this;
            const p = function(ind, key, def, prof) { return self._getParam(ind, key, def, prof); };
            let need = 0;
            for (let i = 0; i < list.length; i++) {
                const ind = String(list[i]).toUpperCase();
                let n = 0;
                switch (ind) {
                    case 'RSI':   n = p('RSI', 'period', 14, profile.rsiPeriod) + 2; break;
                    case 'SMA':   n = p('SMA', 'slow', 14, profile.smaSlow) + 1; break;
                    case 'EMA':   n = p('EMA', 'slow', 21, profile.emaSlow) + 1; break;
                    case 'BB':    n = p('BB', 'period', 20, profile.bbPeriod) + 1; break;
                    case 'MACD':  n = p('MACD', 'slow', 26, profile.macdSlow) + p('MACD', 'signal', 9, profile.macdSig) + 1; break;
                    case 'STOCH': n = p('STOCH', 'kPeriod', 14, profile.stochK) + p('STOCH', 'dPeriod', 3, profile.stochD) + 1; break;
                    case 'CCI':   n = p('CCI', 'period', 20, profile.cciPeriod) + 1; break;
                    case 'TREND': n = p('TREND', 'period', 5, profile.trendPeriod) + 1; break;
                    case 'PSAR':  n = Math.max(p('PSAR', 'slowEma', 10, profile.emaSlow), profile.rsiPeriod) + 2; break;
                    case 'SENTIMENT': n = 0; break;
                    default: n = profile.minCandles;
                }
                if (n > need) need = n;
            }
            // Подтверждение входа опирается на EMA и RSI - им тоже нужен запас
            if (getConfirmMode(this.config) !== 'off') {
                need = Math.max(need, Math.max(profile.emaSlow, profile.rsiPeriod) + 3);
            }
            return Math.max(6, need);
        }

        _getAnalysisContext(asset) {
            const exp = parseInt(this.config?.expiration, 10) || 60;
            const profile = getAnalysisProfile(exp, this._analysisTimeframeSeconds());
            const ticks = this._getTicksForAsset(asset);
            const real = getRealCandles(this, asset, profile.candleMs);
            const all = buildCandles(ticks, profile.candleMs, real);

            // Последняя свеча ещё формируется - решения по ней «перерисовываются»,
            // поэтому анализ идёт только по закрытым барам.
            const nowBucket = Math.floor(Date.now() / profile.candleMs) * profile.candleMs;
            let forming = null;
            let candles = all;
            if (all.length && all[all.length - 1].ts >= nowBucket) {
                forming = all[all.length - 1];
                candles = all.slice(0, -1);
            }

            const closes = candleCloses(candles);
            const htf = this.config?.htfFilter ? getHtfContext(ticks, exp, this, asset) : null;
            const minRequired = this._requiredCandles(profile, this._indicatorList());
            return {
                profile,
                candles,
                closes,
                forming,
                ticks,
                realCandles: !!(real && real.length),
                ready: candles.length >= minRequired,
                candleCount: candles.length,
                tickCount: ticks.length,
                minRequired,
                candleSec: profile.candleSec,
                htf
            };
        }

        _getPricesForAsset(asset) {
            if (!asset) return [];
            const direct = this._prices[asset];
            if (direct && direct.length) return direct;
            for (const key of Object.keys(this._prices)) {
                if (assetsMatch(key, asset)) return this._prices[key] || [];
            }
            return [];
        }

        stop() {
            const wasPrimary = isPrimarySignalFrame();
            this.isRunning=false;
            this._tradeBusy=false;
            if(this._loopTimer){clearInterval(this._loopTimer);this._loopTimer=null;}
            if(this._domTimer){clearInterval(this._domTimer);this._domTimer=null;}
            if(this._resultObserver){this._resultObserver.disconnect();this._resultObserver=null;}
            if (wasPrimary) {
                this.log('🛑 Остановлен');
                releasePrimaryEngine();
            }
            // Оверлей живёт по галочке, анализ ему не нужен
            try {
                if (this.config && this.config.chartOverlay) PosChartOverlay.startLoop();
                else PosChartOverlay.stopLoop(true);
            } catch (_) {}
        }

        onPrice(d) {
            if(!d||typeof d.price!=='number') return;
            const name=normalizeAssetName(d.asset);
            if(!name||name==='UNKNOWN'||!looksLikeAsset(name)) return;
            const ts = d.timestamp || Date.now();
            if(!this._ticks[name]) this._ticks[name]=[];
            if(!this._prices[name]) this._prices[name]=[];

            // Дедуп по timestamp при подгрузке истории (чтобы не раздувать буфер)
            const ticks = this._ticks[name];
            if (d.fromHistory && ticks.length) {
                const last = ticks[ticks.length - 1];
                if (last && Math.abs(last.ts - ts) < 50 && Math.abs(last.price - d.price) < 1e-12) return;
            }

            ticks.push({ price: d.price, ts: ts });
            // История + live: держим запас под ~90 минутных свечей (и короче)
            const maxTicks = d.fromHistory ? 12000 : 8000;
            if (ticks.length > maxTicks) ticks.splice(0, ticks.length - maxTicks);

            this._prices[name].push(d.price);
            if (this._prices[name].length > 3000) this._prices[name].splice(0, this._prices[name].length - 3000);
            this._priceTickTs[name] = Math.max(this._priceTickTs[name] || 0, ts);

            if (this._domAsset) {
                if (assetsMatch(name, this._domAsset)) {
                    this._wsAsset = name;
                    learnAssetAlias(this._domAsset, name);
                    if (this._domChangedAt) {
                        this.log('📈 Котировки: ' + name + ' ↔ ' + this._domAsset + ' (' + this._prices[name].length + ' тиков)');
                        this._domChangedAt = 0;
                        this._staleStreamLogged = false;
                        this._firstPriceLogged = true;
                    }
                } else if (!this._staleStreamLogged && this._domChangedAt) {
                    this._staleStreamLogged = true;
                    this.log('⏳ Старый поток ' + name + ', жду ' + formatExpectedWs(this._domAsset));
                }
            } else {
                this._wsAsset = name;
            }
            this._wsAssetTime = Date.now();

            if (!this._firstPriceLogged && (!this._domAsset || assetsMatch(name, this._domAsset))) {
                this._firstPriceLogged = true;
                this.log('📈 Котировки: ' + name + ' (' + this._prices[name].length + ' тиков)');
            }
        }

        onSentiment(d) {
            if(!d||!d.asset) return;
            const k=normalizeAssetName(d.asset);
            if (!k) return;
            let up = parseFloat(d.up);
            let down = parseFloat(d.down);
            if (isNaN(up)) return;
            if (isNaN(down)) down = 100 - up;
            up = Math.max(0, Math.min(100, up));
            down = Math.max(0, Math.min(100, down));
            this._sentiment[k]={up:up,down:down,ts:Date.now()};
            if (!this._sentimentLogged || Date.now() - this._sentimentLogged > 12000) {
                this._sentimentLogged = Date.now();
                this.log('🧠 Настроение [' + k + ']: ▲' + up.toFixed(0) + '% / ▼' + down.toFixed(0) + '%');
            }
        }

        onTradeResult(d) {
            if(!d) return;
            const now = Date.now();
            const src = d.source || 'ws';
            // DOM-детектор (наследие Quotex) — только запасной путь: если PO уже присылает
            // закрытия по WebSocket, его срабатывания игнорируем (дубли и ложные WIN сбивали прогрессию).
            if (src === 'dom' && this._wsResultSeen) return;
            if (src === 'ws') this._wsResultSeen = true;
            if (d.id != null && d.id !== '') {
                const key = String(d.id);
                if (!this._resultIds) this._resultIds = new Set();
                if (this._resultIds.has(key)) return;
                this._resultIds.add(key);
                if (this._resultIds.size > 500) this._resultIds = new Set(Array.from(this._resultIds).slice(-200));
            } else if (this._lastResultAt && now - this._lastResultAt < 2200) {
                return; // без id дубль можно отличить только по времени
            }
            const result=d.result||(d.profit>0?'WIN':'LOSE');
            if (result === 'DRAW') { this._recordReverseResult('DRAW'); this._settlePending(); return; }
            if (result !== 'WIN' && result !== 'LOSE') return;
            this._recordReverseResult(result);
            this._lastResultAt = now;
            const profit=parseFloat(d.profit||0);
            this._lastResult=result;
            this.money.recordResult(result,profit);
            const nextBet = this.money.onResult(result);
            this._settlePending();
            this._post('POROBOT_TRADE_RESULT',{result,profit,amount:d.amount,nextBet:nextBet,mmStep:this.money._step,mm:this.money.strategy});
            const mmNote = this.money.isProgressive() ? ' | след. ставка $' + nextBet + ' (шаг ' + this.money._step + ')' : '';
            this.log(`${result==='WIN'?'✅':'❌'} Результат: ${result} | P&L: ${profit>=0?'+':'-'}$${Math.abs(profit).toFixed(2)}${mmNote}`);
        }

        /** Закрылась одна из открытых авто-сделок. */
        _settlePending() {
            if (this._pendingTrades && this._pendingTrades.length) this._pendingTrades.shift();
        }

        /**
         * Прогрессии (мартингейл и др.) нужен итог прошлой сделки до входа в следующую:
         * новый сигнал часто приходит ровно на закрытии свечи, раньше чем PO пришлёт результат,
         * и сделка уходила базовой ставкой. Пока авто-сделка не закрыта, новых не открываем.
         * Если результат так и не пришёл (экспирация + 20 с), ждать перестаём.
         */
        _awaitingResult() {
            if (!this.money || !this.money.isProgressive()) return false;
            const list = this._pendingTrades || [];
            const now = Date.now();
            while (list.length && now > list[0].deadline) {
                list.shift();
                this.log('⚠️ Итог сделки не получен вовремя - следующий вход без учёта её результата');
            }
            if (!list.length) return false;
            if (now - (this._awaitLoggedAt || 0) > 15000) {
                this._awaitLoggedAt = now;
                this.log('⏳ ' + this.money.strategy + ': жду итог прошлой сделки перед следующим входом');
            }
            return true;
        }

        _addPending(count, expSec) {
            if (!this._pendingTrades) this._pendingTrades = [];
            const deadline = Date.now() + (Math.max(3, parseInt(expSec, 10) || 60) + 20) * 1000;
            for (let i = 0; i < count; i++) this._pendingTrades.push({ deadline });
        }

        _watchResults() {
            if(this._resultObserver) return;
            const self=this;
            let lastTs=0;
            const COOLDOWN=8000;
            this._resultObserver=new MutationObserver(mutations=>{
                if (self._multiModeEverUsed) return;
                for(const mut of mutations) {
                    for(const node of mut.addedNodes) {
                        if(node.nodeType!==1) continue;
                        // Quotex показывает результат в уведомлениях или попапах
                        const notif=node.matches&&(node.matches('[class*="notification"]')||node.matches('[class*="deal-result"]')||node.matches('[class*="popup"]'))
                            ? node : (node.querySelector&&node.querySelector('[class*="notification"],[class*="deal-result"],[class*="win"],[class*="lose"]'));
                        if(!notif) continue;
                        if(notif._posProcessed) continue;
                        notif._posProcessed=true;
                        if(Date.now()-lastTs<COOLDOWN) continue;
                        const text=notif.textContent||'';
                        const allCls=[notif,...Array.from(notif.querySelectorAll('*'))].map(el=>el.className||'').join(' ').toLowerCase();
                        const amtMatch=text.match(/([\d.,]+)\s*[$€£₴₽]/u);
                        const amount=amtMatch?parseFloat(amtMatch[1].replace(/,/g,'.')):0;
                        let result;
                        if(amount>0) result='WIN';
                        else {
                            const isLose=/lose|loss|fail|danger/.test(allCls)||/lose|проигр|потер|убыт|истек|закрыт|0[,.]00/i.test(text);
                            if(!isLose) continue;
                            result='LOSE';
                        }
                        const profit=result==='WIN'?amount:-(self.money._bet||1);
                        lastTs=Date.now();
                        self.onTradeResult({result,profit,amount:self.money._bet||amount,source:'dom'});
                    }
                }
            });
            try { this._resultObserver.observe(document.body,{childList:true,subtree:true}); }
            catch(e) { this.log('⚠️ Авто-детект недоступен: '+e.message); }
        }

        _getParam(ind, key, def, profileDef) {
            const c=this.config?.indConfig?.[ind.toUpperCase()];
            const v=c?.[key];
            if (v!=null&&!isNaN(parseFloat(v))) return parseFloat(v);
            if (profileDef != null) return profileDef;
            return def;
        }

        _signalFor(ind, assetKey, ctx) {
            const i=(ind||'RSI').toUpperCase();
            const prices = ctx && ctx.closes ? ctx.closes : [];
            const profile = ctx && ctx.profile ? ctx.profile : getAnalysisProfile(60);
            // Sentiment не зависит от свечей - проверяем до minCandles-гейта
            if (i === 'SENTIMENT') {
                let s = this._sentiment[assetKey];
                if (!s) {
                    const keys = Object.keys(this._sentiment);
                    for (let si = 0; si < keys.length; si++) {
                        if (assetsMatch(keys[si], assetKey) || (this._domAsset && assetsMatch(keys[si], this._domAsset))) {
                            s = this._sentiment[keys[si]];
                            break;
                        }
                    }
                }
                if(!s||Date.now()-s.ts>20000) return 'NEUTRAL';
                const thr = this._getParam('SENTIMENT','threshold',60);
                return s.up>=thr?'UP':s.down>=thr?'DOWN':'NEUTRAL';
            }
            const minNeeded = (ctx && ctx.minRequired) || profile.minCandles;
            if(!prices||prices.length<minNeeded) return 'NEUTRAL';
            const candles = (ctx && ctx.candles) ? ctx.candles : [];
            switch(i) {
                case 'RSI': {
                    const r=CoreIndicators.rsi(prices, this._getParam('RSI','period', 14, profile.rsiPeriod));
                    if(r===null) return 'NEUTRAL';
                    return r<=this._getParam('RSI','oversold',30)?'UP':r>=this._getParam('RSI','overbought',70)?'DOWN':'NEUTRAL';
                }
                case 'SMA': {
                    const f=CoreIndicators.sma(prices, this._getParam('SMA','fast',5, profile.smaFast));
                    const s=CoreIndicators.sma(prices, this._getParam('SMA','slow',14, profile.smaSlow));
                    if(!f||!s) return 'NEUTRAL'; return f>s?'UP':'DOWN';
                }
                case 'EMA': {
                    const f=CoreIndicators.ema(prices, this._getParam('EMA','fast',5, profile.emaFast));
                    const s=CoreIndicators.ema(prices, this._getParam('EMA','slow',21, profile.emaSlow));
                    if(!f||!s) return 'NEUTRAL'; return f>s?'UP':'DOWN';
                }
                case 'BB': {
                    const bb=CoreIndicators.bb(prices, this._getParam('BB','period',20, profile.bbPeriod), this._getParam('BB','dev',2));
                    if(!bb) return 'NEUTRAL'; const p=prices[prices.length-1];
                    return p<=bb.lower?'UP':p>=bb.upper?'DOWN':'NEUTRAL';
                }
                case 'MACD': {
                    const m=CoreIndicators.macd(
                        prices,
                        this._getParam('MACD','fast',12, profile.macdFast),
                        this._getParam('MACD','slow',26, profile.macdSlow),
                        this._getParam('MACD','signal',9, profile.macdSig)
                    );
                    if(!m) return 'NEUTRAL'; return m.macd>m.signal?'UP':m.macd<m.signal?'DOWN':'NEUTRAL';
                }
                case 'STOCH': {
                    const kP=this._getParam('STOCH','kPeriod',14, profile.stochK);
                    const dP=this._getParam('STOCH','dPeriod',3, profile.stochD);
                    const st=candles.length ? CoreIndicators.stochHL(candles, kP, dP)
                                            : CoreIndicators.stoch(prices, kP, dP);
                    if(!st) return 'NEUTRAL';
                    const lo=this._getParam('STOCH','oversold',20);
                    const hi=this._getParam('STOCH','overbought',80);
                    return (st.k<=lo&&st.d<=lo)?'UP':(st.k>=hi&&st.d>=hi)?'DOWN':'NEUTRAL';
                }
                case 'CCI': {
                    const cP=this._getParam('CCI','period',20, profile.cciPeriod);
                    const c=candles.length ? CoreIndicators.cciTP(candles, cP)
                                           : CoreIndicators.cci(prices, cP);
                    if(c===null) return 'NEUTRAL';
                    const lvl=this._getParam('CCI','level',100);
                    return c<=-lvl?'UP':c>=lvl?'DOWN':'NEUTRAL';
                }
                case 'TREND': return CoreIndicators.trend(prices, this._getParam('TREND','period',5, profile.trendPeriod));
                case 'PSAR': {
                    const ef=CoreIndicators.ema(prices, this._getParam('PSAR','fastEma',3, profile.emaFast));
                    const es=CoreIndicators.ema(prices, this._getParam('PSAR','slowEma',10, profile.emaSlow));
                    const r=CoreIndicators.rsi(prices, profile.rsiPeriod);
                    if(!ef||!es||!r) return 'NEUTRAL';
                    return (ef>es&&r<65)?'UP':(ef<es&&r>35)?'DOWN':'NEUTRAL';
                }
                default: return 'NEUTRAL';
            }
        }

        _generateSignal(assetKey, ctx) {
            const list=this._indicatorList();
            let mode=(this.config?.filterMode||'ALL').toUpperCase();
            const results=list.map(ind=>({ind,sig:this._signalFor(ind,assetKey,ctx)}));
            const indicators=results.map(r=>({id:r.ind,signal:r.sig}));
            const nonN=results.filter(r=>r.sig!=='NEUTRAL');
            const ups=nonN.filter(r=>r.sig==='UP').length;
            const dns=nonN.filter(r=>r.sig==='DOWN').length;
            const candles = (ctx && ctx.candles) || [];
            const profile = (ctx && ctx.profile) || getAnalysisProfile(60);
            const self = this;

            const htf = ctx && ctx.htf;
            const htfBlocks = function(dir) {
                return !!(htf && htf.ready && htf.direction !== 'NEUTRAL' && dir !== 'NEUTRAL' && dir !== htf.direction);
            };
            const pack = function(direction, matched, extra) {
                return Object.assign({
                    direction,
                    matchedCount: matched.length,
                    totalCount: list.length,
                    matchedIndicators: matched.map(r => r.ind).join('+') || list.join('+'),
                    indicators,
                    filterMode: mode,
                    multiTrade: false,
                    multiSignals: [],
                    rejectReason: null,
                    confirmMode: null
                }, extra || {});
            };

            // Смесь тренда и возврата в режиме ALL почти никогда не сходится:
            // один стиль требует продолжения, другой - отката. Берём CONTEXT.
            if (mode === 'ALL') {
                const hasTrend = results.some(r => indicatorStyle(r.ind) === 'trend');
                const hasRev = results.some(r => indicatorStyle(r.ind) === 'reversion');
                if (hasTrend && hasRev) {
                    mode = 'CONTEXT';
                    if (!this._mixedAllLogged) {
                        this._mixedAllLogged = true;
                        this.log('ℹ️ ALL со смешанными фильтрами → CONTEXT (тренд задаёт сторону, осциллятор - вход)');
                    }
                }
            }

            // ── КОНТЕКСТ + ТРИГГЕР: тренд разрешает направление, осциллятор даёт вход
            if (mode === 'CONTEXT') {
                const contextInds = results.filter(r => indicatorStyle(r.ind) !== 'reversion');
                const triggerInds = results.filter(r => indicatorStyle(r.ind) === 'reversion');
                if (!triggerInds.length) mode = 'ALL';
                else if (!contextInds.length) mode = 'ANY';
                else {
                    const policy = getTriggerPolicy(this.config, triggerInds.length);
                    const fired = triggerInds.filter(r => r.sig !== 'NEUTRAL');
                    const tUp = fired.filter(r => r.sig === 'UP').length;
                    const tDn = fired.length - tUp;
                    if (!fired.length) return pack('NEUTRAL', [], { rejectReason: 'нет триггера входа' });
                    if (tUp && tDn) return pack('NEUTRAL', [], { rejectReason: 'триггеры разошлись' });
                    if (policy === 'all' && fired.length !== triggerInds.length) {
                        return pack('NEUTRAL', [], { rejectReason: 'не все триггеры сработали (' + fired.length + '/' + triggerInds.length + ')' });
                    }

                    const dir = tUp ? 'UP' : 'DOWN';
                    const ctxNeutral = contextInds.filter(r => r.sig === 'NEUTRAL');
                    if (ctxNeutral.length) {
                        return pack('NEUTRAL', [], { rejectReason: 'контекст неполный (' + ctxNeutral.map(r => r.ind).join('+') + ')' });
                    }
                    if (contextInds.some(r => r.sig !== dir)) return pack('NEUTRAL', [], { rejectReason: 'контекст против входа' });

                    const confirmMode = resolveConfirmMode(this.config, fired.map(r => r.ind));
                    const q = confirmSignalQuality(dir, candles, profile, confirmMode, this.config);
                    if (!q.ok) return pack('NEUTRAL', [], { rejectReason: q.reason, confirmMode });
                    if (htfBlocks(dir)) {
                        return pack('NEUTRAL', [], { rejectReason: 'HTF ' + htf.sec + 'с против входа', confirmMode });
                    }
                    return pack(dir, fired.concat(contextInds), { confirmMode });
                }
            }

            if (mode === 'ALL') {
                let direction = 'NEUTRAL';
                let reject = null;
                if (nonN.length !== list.length) {
                    reject = 'не все фильтры дали сигнал (' + nonN.length + '/' + list.length + ')';
                } else if (ups === list.length) {
                    direction = 'UP';
                } else if (dns === list.length) {
                    direction = 'DOWN';
                } else {
                    reject = 'фильтры разошлись';
                }

                let matched = nonN.filter(r => r.sig === direction);
                let confirmMode = null;
                if (direction !== 'NEUTRAL') {
                    confirmMode = resolveConfirmMode(this.config, matched.map(r => r.ind));
                    const q = confirmSignalQuality(direction, candles, profile, confirmMode, this.config);
                    if (!q.ok) { reject = q.reason; direction = 'NEUTRAL'; matched = []; }
                }
                if (direction !== 'NEUTRAL' && htfBlocks(direction)) {
                    reject = 'HTF ' + htf.sec + 'с против входа';
                    direction = 'NEUTRAL';
                    matched = [];
                }
                return pack(direction, matched, { rejectReason: reject, confirmMode });
            }

            // ANY: каждый не-NEUTRAL фильтр - отдельный кандидат на сделку,
            // и подтверждение подбирается под стиль именно этого индикатора
            let lastReject = null;
            let multiSignals = nonN.filter(function(r) {
                const cm = resolveConfirmMode(self.config, [r.ind]);
                const q = confirmSignalQuality(r.sig, candles, profile, cm, self.config);
                if (!q.ok) lastReject = r.ind + ': ' + q.reason;
                return q.ok;
            });
            if (!nonN.length) lastReject = 'ни один фильтр не сработал';

            if (htf && htf.ready && htf.direction !== 'NEUTRAL') {
                const before = multiSignals.length;
                multiSignals = multiSignals.filter(r => r.sig === htf.direction);
                if (before && !multiSignals.length) lastReject = 'HTF ' + htf.sec + 'с против входа';
            }

            let direction = 'NEUTRAL';
            if (multiSignals.length) {
                const mUp = multiSignals.filter(function(r) { return r.sig === 'UP'; }).length;
                const mDn = multiSignals.filter(function(r) { return r.sig === 'DOWN'; }).length;
                direction = mUp >= mDn ? 'UP' : 'DOWN';
            }

            return pack(direction, multiSignals, {
                multiTrade: true,
                multiSignals: multiSignals.map(function(r) { return { id: r.ind, direction: r.sig }; }),
                rejectReason: multiSignals.length ? null : lastReject
            });
        }

        _buildScanState(scanAsset, ctx) {
            const list=this._indicatorList();
            const mode=(this.config?.filterMode||'ALL').toUpperCase();
            const onlySentiment = list.length === 1 && String(list[0]).toUpperCase() === 'SENTIMENT';
            if (ctx && (ctx.ready || onlySentiment)) return this._generateSignal(scanAsset, ctx);
            return {
                direction:'NEUTRAL',
                matchedCount:0,
                totalCount:list.length,
                matchedIndicators:'',
                indicators:list.map(id=>({id,signal:'NEUTRAL'})),
                filterMode:mode,
                multiTrade:false,
                multiSignals:[],
                rejectReason: ctx ? ('прогрев ' + ctx.candleCount + '/' + ctx.minRequired + ' свечей') : 'нет данных',
                confirmMode:null
            };
        }

        // Почему сигнала нет - самая полезная строка для настройки пресета.
        // Пишем только при смене причины и не чаще раза в 8 секунд.
        _logReject(asset, sig) {
            if (this.config?.diagRejects === false) return;
            if (!sig || sig.direction !== 'NEUTRAL' || !sig.rejectReason) return;
            const key = asset + '|' + sig.rejectReason;
            const now = Date.now();
            if (this._lastRejectKey === key) return;
            if (this._lastRejectAt && now - this._lastRejectAt < 8000) return;
            this._lastRejectKey = key;
            this._lastRejectAt = now;
            const cm = sig.confirmMode ? ' · подтв: ' + sig.confirmMode : '';
            this.log('🔎 [' + asset + '] входа нет - ' + sig.rejectReason + cm);
        }


        _startMultiPairTrading() {
            this._multiModeEverUsed = true;
            this._multiPairs = this._multiPairs || new Map();
            this._multiSubscribed = this._multiSubscribed || new Set();
            this._multiOpenByAsset = this._multiOpenByAsset || new Map();
            this._multiPendingByRequestId = this._multiPendingByRequestId || new Map();
            this._multiTradesById = this._multiTradesById || new Map();
            this._multiLastEntryBar = this._multiLastEntryBar || {};
            this._multiRequestId = this._multiRequestId || (Date.now() * 1000);
            this._multiSocket = this._multiSocket || null;
            this._multiLastRefreshAt = 0;
            this._multiModeLogged = false;
            this._multiAccountWarned = false;
            this._refreshMultiPairs(true);
        }

        _refreshMultiPairs(force, predictiveOnly) {
            predictiveOnly = predictiveOnly === true;
            if (predictiveOnly) {
                if (!isPrimarySignalFrame() || !this.predictiveConfig || !this.predictiveConfig.enabled || this.predictiveConfig.assetMode === 'current') return;
                const now = Date.now();
                if (!force && this._predictiveLastRefreshAt && now - this._predictiveLastRefreshAt < 10000) return;
                this._predictiveLastRefreshAt = now;
            } else if (!this.isRunning || !this.config?.multiPairTrading) return;
            this._multiSubscribed = this._multiSubscribed || new Set();
            const ws = getActivePoSocket();
            if (!ws) {
                const waitNow = Date.now();
                if (!this._multiWaitLogAt || waitNow - this._multiWaitLogAt > 10000) {
                    this._multiWaitLogAt = waitNow;
                    this.log('⏳ Мульти-пары: ожидаю активное WebSocket-соединение Pocket Option (.po.market).');
                }
                return;
            }
            if (this._multiSocket !== ws) {
                this._multiSocket = ws;
                this._multiSubscribed = new Set();
            }
            const minProfitRaw = parseFloat(this.config && this.config.minProfit);
            const minProfit = predictiveOnly ? 0 : (isFinite(minProfitRaw) ? Math.max(0, Math.min(100, minProfitRaw)) : 92);
            const includeOtc = predictiveOnly ? true : this.config.includeOtc !== false;
            const catalog = window.__poAssetCatalog || {};
            const next = new Map();
            Object.keys(catalog).forEach((key) => {
                const item = catalog[key];
                if (!item || !item.active || !isFxCurrencyPair(item.symbol || key)) return;
                if (!includeOtc && /_OTC$/i.test(String(item.symbol || key))) return;
                const normalized = normalizeAssetName(item.symbol || key);
                if (predictiveOnly && this.predictiveConfig.assetMode === 'selected' && this.predictiveConfig.selectedAsset && this.predictiveConfig.selectedAsset !== '*' && normalized !== normalizeAssetName(this.predictiveConfig.selectedAsset)) return;
                if (predictiveOnly && !/_OTC$/i.test(normalized)) return;
                const payout = parseFloat(item.profit);
                if (!isFinite(payout) || payout < minProfit) return;
                next.set(normalized, {
                    symbol: normalized,
                    raw: item.raw || toPoAssetId(item.symbol || key),
                    profit: payout,
                    label: item.label || item.symbol || key
                });
            });
            if (predictiveOnly) this._predictivePairs = next;
            else this._multiPairs = next;
            const exp = parseInt(this.config && this.config.expiration, 10) || Number(this.predictiveConfig && this.predictiveConfig.horizonSeconds) || 60;
            const profile = getAnalysisProfile(exp, this._analysisTimeframeSeconds());
            let subscribed = 0;
            for (const [asset, item] of next) {
                if (this._multiSubscribed.has(asset)) continue;
                const raw = item.raw || toPoAssetId(asset);
                if (!raw) continue;
                try {
                    // This is the same per-symbol subscription pattern used by 1.1.7_0.
                    ws.send('42["subfor",' + JSON.stringify(raw) + ']');
                    ws.send('42["changeSymbol",' + JSON.stringify({ asset: raw, period: profile.candleSec }) + ']');
                    this._multiSubscribed.add(asset);
                    subscribed++;
                } catch (_) {}
            }
            const now = Date.now();
            if (predictiveOnly) {
                this._post('POROBOT_PREDICTIVE_ASSETS', { assets: Array.from(next.keys()) });
                if (force || subscribed || now - (this._predictivePairsLogAt || 0) > 15000) {
                    this._predictivePairsLogAt = now;
                    this.log('🔮 Predictive OTC: ' + next.size + ' активных OTC-пар | новых подписок: ' + subscribed);
                }
            } else if (force || subscribed || now - this._multiLastRefreshAt > 15000) {
                this._multiLastRefreshAt = now;
                this.log('🌐 Мульти-пары: ' + next.size + ' валютных пар с доходностью ≥ ' + minProfit + '% | подписано новых: ' + subscribed);
            }
        }

        _getTradeDirection(signalDirection) {
            if (signalDirection !== 'UP' && signalDirection !== 'DOWN') return signalDirection;
            return this.config?.reverseEnabled && this._reverseMode
                ? (signalDirection === 'UP' ? 'DOWN' : 'UP')
                : signalDirection;
        }

        _recordReverseResult(result) {
            if (!this.config?.reverseEnabled) return;
            if (result === 'LOSE' || result === 'DRAW') { this._reverseWinCount = 0; return; }
            if (result !== 'WIN') return;
            const raw = parseInt(this.config.reverseWins, 10);
            const threshold = isFinite(raw) ? Math.max(1, Math.min(20, raw)) : 3;
            this._reverseWinCount++;
            if (this._reverseWinCount >= threshold) {
                this._reverseWinCount = 0;
                this._reverseMode = !this._reverseMode;
                this.log('🔁 REVERS: серия из ' + threshold + ' побед — режим ' +
                    (this._reverseMode ? 'ВКЛЮЧЁН (против сигнала)' : 'ВЫКЛЮЧЕН (по сигналу)') + '.');
            } else {
                this.log('🔁 REVERS: побед подряд ' + this._reverseWinCount + '/' + threshold +
                    (this._reverseMode ? ' · противоположное направление' : ''));
            }
        }

        setPredictiveConfig(config) {
            const defaults = {
                enabled: true, sourceMode: 'formula', assetMode: 'all', selectedAsset: '*',
                horizonSeconds: 60, model: 'auto', confidenceFloor: 0.52,
                autoTrade: false, accountMode: 'demo', stake: 1, maxConcurrentTrades: 1
            };
            this.predictiveConfig = Object.assign({}, defaults, config || {});
            this.predictiveConfig.horizonSeconds = [60,120,180,240,300].includes(Number(this.predictiveConfig.horizonSeconds))
                ? Number(this.predictiveConfig.horizonSeconds) : 60;
            this.predictiveConfig.confidenceFloor = Math.max(0.5, Math.min(0.95, Number(this.predictiveConfig.confidenceFloor) || 0.52));
            this.predictiveConfig.stake = Math.max(1, Math.min(100000, Number(this.predictiveConfig.stake) || 1));
            this.predictiveConfig.maxConcurrentTrades = Math.max(1, Math.min(20, parseInt(this.predictiveConfig.maxConcurrentTrades, 10) || 1));
            if (this._predictiveRefreshTimer) { clearInterval(this._predictiveRefreshTimer); this._predictiveRefreshTimer = null; }
            if (this.predictiveConfig.enabled && this.predictiveConfig.assetMode !== 'current' && isPrimarySignalFrame()) {
                this._refreshMultiPairs(true, true);
                const self = this;
                this._predictiveRefreshTimer = setInterval(function() { self._refreshMultiPairs(false, true); }, 10000);
            }
        }

        onPredictiveForecast(forecast) {
            const cfg = this.predictiveConfig;
            if (!isPrimarySignalFrame() || !cfg || !cfg.enabled || cfg.sourceMode === 'indicators' || !forecast || !/_OTC$/i.test(forecast.asset || '')) return;
            const asset = normalizeAssetName(forecast.asset);
            if (cfg.selectedAsset && cfg.selectedAsset !== '*' && normalizeAssetName(cfg.selectedAsset) !== asset) return;
            if (cfg.assetMode === 'current') {
                const currentAsset = normalizeAssetName(this._resolveScanAsset() || this._domAsset || '');
                if (!currentAsset || currentAsset !== asset) return;
            }
            const horizon = Number(cfg.horizonSeconds) || 60;
            if (cfg.assetMode !== 'current' && (!this._predictiveLastRefreshAt || Date.now() - this._predictiveLastRefreshAt > 10000)) this._refreshMultiPairs(false, true);
            const row = forecast.horizons && forecast.horizons[horizon];
            if (!row) return;
            const model = cfg.model === 'auto' ? row.model : cfg.model;
            const direction = row.modelDirections && row.modelDirections[model];
            const confidence = cfg.model === 'auto' ? row.confidence : (row.modelConfidence && row.modelConfidence[model]);
            const eligible = cfg.model === 'auto' ? row.eligible : (row.modelEligible && row.modelEligible[model]);
            if (!['UP','DOWN'].includes(direction) || !eligible || !Number.isFinite(confidence) || confidence < cfg.confidenceFloor) return;
            if (cfg.sourceMode === 'combined') {
                const indicator = this._lastIndicatorByAsset && this._lastIndicatorByAsset[asset];
                if (!indicator || Date.now() - indicator.timestamp > 12000 || indicator.direction !== direction) return;
            }
            const signal = {
                asset, direction, model, horizonSeconds: horizon, confidence,
                confidenceSamples: cfg.model === 'auto' ? row.confidenceSamples : undefined,
                currentPrice: forecast.currentPrice,
                predictedPrice: row.models[model],
                timestamp: forecast.timestamp, sourceMode: cfg.sourceMode
            };
            this._post('POROBOT_PREDICTIVE_SIGNAL', { signal });
            if (cfg.autoTrade) this._openPredictiveOrder(signal, cfg);
        }

        _openPredictiveOrder(signal, cfg) {
            const now = Date.now();
            this._multiOpenByAsset = this._multiOpenByAsset || new Map();
            this._multiPendingByRequestId = this._multiPendingByRequestId || new Map();
            this._multiTradesById = this._multiTradesById || new Map();
            this._multiRequestId = this._multiRequestId || (Date.now() * 1000);
            this._predictiveLastTradeAt = this._predictiveLastTradeAt || {};
            if (this._multiOpenByAsset.has(signal.asset)) return;
            if (this._multiOpenByAsset.size >= cfg.maxConcurrentTrades) return;
            const cooldownKey = signal.asset + '|' + signal.horizonSeconds;
            if (now - (this._predictiveLastTradeAt[cooldownKey] || 0) < signal.horizonSeconds * 1000) return;
            const accountType = window._poLastWsAccountType || detectActiveAccountType();
            if (accountType !== cfg.accountMode) {
                if (!this._predictiveAccountWarnAt || now - this._predictiveAccountWarnAt > 15000) {
                    this._predictiveAccountWarnAt = now;
                    this.log('⛔ Predictive: выбран ' + String(cfg.accountMode).toUpperCase() +
                        ', но Pocket Option определил ' + String(accountType || 'unknown').toUpperCase() + '. Сделка не отправлена.');
                }
                return;
            }
            const catalog = window.__poAssetCatalog || {};
            let item = null;
            for (const key of Object.keys(catalog)) {
                const candidate = catalog[key];
                if (candidate && candidate.active && normalizeAssetName(candidate.symbol || key) === signal.asset) {
                    item = candidate;
                    break;
                }
            }
            if (!item || !isFxCurrencyPair(item.symbol || item.label || signal.asset) || !/_OTC$/i.test(signal.asset)) return;
            const amount = Number(cfg.stake);
            if (!Number.isFinite(amount) || amount <= 0) return;
            const balanceInfo = getActiveBalanceInfo();
            const balance = balanceInfo ? Number(balanceInfo.balance) : NaN;
            if (Number.isFinite(balance) && balance + 1e-9 < amount) {
                this.log('⛔ Predictive [' + signal.asset + ']: недостаточно средств для ставки $' + amount.toFixed(2));
                return;
            }
            const ws = getActivePoSocket();
            if (!ws) return;
            const rawAsset = item.raw || toPoAssetId(signal.asset);
            if (!rawAsset) return;
            const tradeDirection = signal.direction; // Predictive module is independent from the existing REVERS setting.
            const requestId = ++this._multiRequestId;
            const payload = {
                asset: rawAsset, amount,
                action: tradeDirection === 'UP' ? 'call' : 'put',
                isDemo: accountType === 'demo' ? 1 : 0,
                requestId, optionType: 100, time: signal.horizonSeconds
            };
            try {
                ws.send('42["openOrder",' + JSON.stringify(payload) + ']');
                const trade = {
                    requestId: String(requestId), asset: signal.asset,
                    direction: tradeDirection, signalDirection: signal.direction,
                    reversed: tradeDirection !== signal.direction, amount,
                    expiration: signal.horizonSeconds, payout: Number(item.profit) || 0,
                    openedAt: now, deadline: now + (signal.horizonSeconds + 30) * 1000,
                    source: 'predictive', model: signal.model, confidence: signal.confidence
                };
                this._multiPendingByRequestId.set(String(requestId), trade);
                this._multiOpenByAsset.set(signal.asset, 'req:' + requestId);
                this._predictiveLastTradeAt[cooldownKey] = now;
                const self = this, requestKey = String(requestId);
                setTimeout(function() {
                    const stillPending = self._multiPendingByRequestId && self._multiPendingByRequestId.get(requestKey);
                    if (!stillPending) return;
                    self._multiPendingByRequestId.delete(requestKey);
                    if (self._multiOpenByAsset.get(signal.asset) === 'req:' + requestKey) self._multiOpenByAsset.delete(signal.asset);
                    delete self._predictiveLastTradeAt[cooldownKey];
                    self.log('⚠️ Predictive [' + signal.asset + ']: платформа не подтвердила открытие ордера за 15 секунд.');
                }, 15000);
                this._post('POROBOT_PREDICTIVE_TRADE_OPEN', { trade });
                this.log('🤖 Predictive [' + signal.asset + '] ' + tradeDirection + ' · ' + signal.model +
                    ' · ' + Math.round(signal.confidence * 100) + '% · $' + amount.toFixed(2) +
                    ' · ' + signal.horizonSeconds + 'с');
            } catch (error) {
                this.log('⚠️ Predictive [' + signal.asset + ']: ошибка отправки ордера — ' +
                    (error && error.message ? error.message : 'WebSocket'));
            }
        }

        _scanMultiPairs() {
            if (!this.isRunning || !isPrimarySignalFrame()) return;
            const now = Date.now();
            if (!this._multiPairs || !this._multiPairs.size || now - (this._multiLastRefreshAt || 0) > 10000) {
                this._refreshMultiPairs(false);
            }
            if (!this._multiPairs || !this._multiPairs.size) return;

            // Pending requests are bounded; a missing server acknowledgement must not block a pair forever.
            const expSec = parseInt(this.config?.expiration, 10) || 60;
            for (const [requestId, trade] of this._multiPendingByRequestId || []) {
                if (now > trade.deadline) {
                    this._multiPendingByRequestId.delete(requestId);
                    if (this._multiOpenByAsset.get(trade.asset) === 'req:' + requestId) this._multiOpenByAsset.delete(trade.asset);
                    this.log('⚠️ [' + trade.asset + '] нет подтверждения открытия — запрос снят с учёта');
                }
            }

            const maxRaw = parseInt(this.config.maxConcurrentTrades, 10);
            const maxOpen = isFinite(maxRaw) ? Math.max(1, Math.min(20, maxRaw)) : 4;
            const minProfitRaw = parseFloat(this.config.minProfit);
            const minProfit = isFinite(minProfitRaw) ? Math.max(0, Math.min(100, minProfitRaw)) : 92;
            const balanceInfo = getActiveBalanceInfo();
            // WS auth is preferred; explicit active-account DOM state is a safe fallback.
            const accountType = window._poLastWsAccountType || detectActiveAccountType();
            const balance = balanceInfo && isFinite(parseFloat(balanceInfo.balance)) ? parseFloat(balanceInfo.balance) : null;
            const amount = capBetToBalance(parseFloat(this.config.baseBet) || 1);
            if (!this._multiModeLogged) {
                this._multiModeLogged = true;
                if (this.config.moneyManagement && this.config.moneyManagement !== 'fixed') {
                    this.log('ℹ️ Мульти-пары используют фиксированную базовую ставку для независимых сделок; прогрессия ММ не применяется.');
                }
            }

            let openCount = this._multiOpenByAsset ? this._multiOpenByAsset.size : 0;
            let reservedThisCycle = 0;
            let tickPairs = 0;
            let readyPairs = 0;
            let signalCount = 0;
            if (openCount >= maxOpen) {
                if (!this._multiDiagAt || now - this._multiDiagAt > 15000) {
                    this._multiDiagAt = now;
                    this.log('📊 Мульти-скан: пар ' + this._multiPairs.size + ' | открыто/ожидает ' + openCount + '/' + maxOpen + ' | лимит одновременных сделок достигнут.');
                }
                return;
            }
            for (const [asset, item] of this._multiPairs) {
                if (openCount >= maxOpen) break;
                if (item.profit < minProfit || this._multiOpenByAsset.has(asset)) continue;
                const ticks = this._getTicksForAsset(asset);
                const lastTickAt = this._priceTickTs[asset] || 0;
                if (!ticks.length || !lastTickAt || now - lastTickAt > 15000) continue;
                tickPairs++;

                const ctx = this._getAnalysisContext(asset);
                if (!ctx || !ctx.ready || !ctx.candles || !ctx.candles.length) continue;
                readyPairs++;
                const sig = this._buildScanState(asset, ctx);
                this._lastIndicatorByAsset = this._lastIndicatorByAsset || {};
                this._lastIndicatorByAsset[normalizeAssetName(asset)] = { direction: sig && sig.direction || 'NEUTRAL', timestamp: Date.now() };
                if (!sig || (sig.direction !== 'UP' && sig.direction !== 'DOWN')) continue;
                signalCount++;
                const barTs = ctx.candles[ctx.candles.length - 1].ts || 0;
                if (!barTs || this._multiLastEntryBar[asset] === barTs) continue;

                const signal = {
                    asset: asset,
                    direction: sig.direction,
                    payout: item.profit,
                    amount: amount,
                    indicators: sig.matchedIndicators || '',
                    expiration: expSec,
                    timestamp: now
                };
                this._multiLastEntryBar[asset] = barTs;
                this._post('POROBOT_MULTI_SIGNAL', { signal: signal });
                if (!this.config.autoTrade) continue;

                if (accountType !== 'demo' && accountType !== 'real') {
                    if (!this._multiAccountWarned) {
                        this._multiAccountWarned = true;
                        this.log('⛔ Мульти-пары: тип счёта не подтверждён WebSocket — открытие сделок заблокировано.');
                    }
                    continue;
                }
                if (accountType === 'real' && this.config.realTradeConfirmed !== true) {
                    if (!this._multiRealWarned) {
                        this._multiRealWarned = true;
                        this.log('⛔ Мульти-пары на REAL заблокированы: сначала подтвердите запуск реальной торговли в интерфейсе.');
                    }
                    continue;
                }
                if (!isFinite(amount) || amount <= 0) continue;
                const liveInfo = getActiveBalanceInfo();
                const liveAmount = liveInfo ? parseFloat(liveInfo.balance) : NaN;
                const available = isFinite(liveAmount) ? liveAmount : balance;
                if (available != null && available + 1e-9 < amount + reservedThisCycle) {
                    this.log('⛔ [' + asset + '] недостаточно свободного баланса для ещё одной сделки');
                    continue;
                }
                const ws = getActivePoSocket();
                if (!ws) continue;
                const tradeDirection = this._getTradeDirection(sig.direction);
                const requestId = ++this._multiRequestId;
                const rawAsset = item.raw || toPoAssetId(asset);
                const payload = {
                    asset: rawAsset,
                    amount: amount,
                    action: tradeDirection === 'UP' ? 'call' : 'put',
                    isDemo: accountType === 'demo' ? 1 : 0,
                    requestId: requestId,
                    optionType: 100,
                    time: expSec
                };
                try {
                    ws.send('42["openOrder",' + JSON.stringify(payload) + ']');
                    const trade = {
                        requestId: String(requestId),
                        asset: asset,
                        direction: tradeDirection,
                        signalDirection: sig.direction,
                        reversed: tradeDirection !== sig.direction,
                        amount: amount,
                        expiration: expSec,
                        payout: item.profit,
                        openedAt: now,
                        deadline: now + (expSec + 30) * 1000
                    };
                    this._multiPendingByRequestId.set(String(requestId), trade);
                    this._multiOpenByAsset.set(asset, 'req:' + requestId);
                    openCount++;
                    reservedThisCycle += amount;
                    this._post('POROBOT_MULTI_TRADE_OPEN', { trade: trade });
                    this.log('🤖 Мульти-сделка [' + asset + '] ' + (tradeDirection === 'UP' ? 'CALL' : 'PUT') +
                        (tradeDirection !== sig.direction ? ' · REVERS' : '') + ' $' + amount.toFixed(2) +
                        ' | выплата ' + item.profit + '% | ' + expSec + 'с');
                } catch (err) {
                    this.log('⚠️ [' + asset + '] ошибка отправки ордера: ' + (err && err.message ? err.message : 'WebSocket'));
                }
            }
            if (!this._multiDiagAt || now - this._multiDiagAt > 15000) {
                this._multiDiagAt = now;
                this.log('📊 Мульти-скан: пар ' + this._multiPairs.size +
                    ' | с котировками ' + tickPairs +
                    ' | прогреты ' + readyPairs +
                    ' | сигналы ' + signalCount +
                    ' | открыто/ожидает ' + this._multiOpenByAsset.size + '/' + maxOpen);
            }
        }

        _handleMultiOpen(payload) {
            const data = Array.isArray(payload) ? payload[0] : payload;
            if (!data) return false;
            const requestId = String(data.requestId ?? data.request_id ?? '');
            const trade = requestId && this._multiPendingByRequestId && this._multiPendingByRequestId.get(requestId);
            if (!trade) return false;
            const id = data.id ?? data.dealId ?? data.deal_id ?? data.orderId ?? data.order_id ?? data.ticket;
            if (id == null) return true;
            this._multiPendingByRequestId.delete(requestId);
            trade.id = String(id);
            trade.deadline = Date.now() + (trade.expiration + 30) * 1000;
            this._multiTradesById.set(String(id), trade);
            this._multiOpenByAsset.set(trade.asset, String(id));
            this.log('✓ Ордер подтверждён [' + trade.asset + '] #' + id);
            return true;
        }

        _handleMultiFail(payload) {
            const data = Array.isArray(payload) ? payload[0] : payload;
            if (!data) return false;
            const requestId = String(data.requestId ?? data.request_id ?? '');
            const trade = requestId && this._multiPendingByRequestId && this._multiPendingByRequestId.get(requestId);
            if (!trade) return false;
            this._multiPendingByRequestId.delete(requestId);
            this._multiOpenByAsset.delete(trade.asset);
            if (trade.source === 'predictive' && this._predictiveLastTradeAt) delete this._predictiveLastTradeAt[trade.asset + '|' + trade.expiration];
            this.log('⚠️ Ордер отклонён [' + trade.asset + ']: ' + String(data.error || 'ошибка платформы'));
            return true;
        }

        _handleMultiClose(deal) {
            if (!deal) return false;
            const id = deal.id ?? deal.ticket ?? deal.orderId ?? null;
            let trade = id != null && this._multiTradesById ? this._multiTradesById.get(String(id)) : null;
            if (!trade) {
                const asset = normalizeAssetName(deal.asset || deal.symbol || '');
                const token = asset && this._multiOpenByAsset ? this._multiOpenByAsset.get(asset) : null;
                if (token && String(token).indexOf('req:') === 0) {
                    trade = this._multiPendingByRequestId.get(String(token).slice(4)) || null;
                } else if (token && this._multiTradesById) {
                    trade = this._multiTradesById.get(String(token)) || null;
                }
            }
            if (!trade) return false;
            if (trade.requestId) this._multiPendingByRequestId.delete(String(trade.requestId));
            if (id != null && this._multiTradesById) this._multiTradesById.delete(String(id));
            this._multiOpenByAsset.delete(trade.asset);
            const net = parseFloat(deal.profit ?? 0);
            const status = String(deal.status || deal.result || deal.state || '').toLowerCase();
            const result = status === 'draw' || status === 'equal' ? 'DRAW' : (status === 'win' || net > 0 ? 'WIN' : 'LOSE');
            const profit = result === 'WIN' ? net : (result === 'LOSE' ? -trade.amount : 0);
            if (trade.source !== 'predictive') this._recordReverseResult(result);
            this._post('POROBOT_MULTI_TRADE_RESULT', { trade: {
                id: id == null ? null : String(id),
                asset: trade.asset,
                direction: trade.direction,
                signalDirection: trade.signalDirection || trade.direction,
                reversed: !!trade.reversed,
                amount: trade.amount,
                result: result,
                profit: profit,
                payout: trade.payout,
                expiration: trade.expiration,
                time: Date.now()
            }});
            this.log((result === 'WIN' ? '✅' : result === 'LOSE' ? '❌' : '➖') + ' [' + trade.asset + '] ' + result + ' | P&L: ' + (profit >= 0 ? '+' : '-') + '$' + Math.abs(profit).toFixed(2));
            return true;
        }

        _scan() {
            if(!this.isRunning || !isPrimarySignalFrame()) return;
            if (this.config?.multiPairTrading) {
                this._scanMultiPairs();
                return;
            }

            // Страховка: если клик по сделке завис, не блокируем сигналы навсегда
            if (this._tradeBusy) {
                const since = this._tradeBusySince || 0;
                if (!since || (Date.now() - since > 25000)) {
                    this._tradeBusy = false;
                    this._tradeBusySince = 0;
                    this.log('⚠️ Сброс блокировки сделки (таймаут 25с)');
                }
            }

            if (frameHasTradeUI()) {
                const expNow = parseInt(this.config?.expiration, 10) || 60;
                if (this._lastAppliedExp !== expNow) {
                    const selfExp = this;
                    const targetExp = expNow;
                    applyPlatformExpiration(targetExp, 4).then(function(ok) {
                        if (ok) selfExp._lastAppliedExp = targetExp;
                    });
                }
                const betNow = capBetToBalance(this.money ? parseFloat(this.money._bet) : (parseFloat(this.config?.baseBet) || 1));
                if (this._lastAppliedBet !== betNow) {
                    this._lastAppliedBet = betNow;
                    setBetAmount(betNow);
                }
            }

            // Диагностика каждые 10 секунд
            if (!this._scanCount) this._scanCount = 0;
            this._scanCount++;
            const scanAsset = this._resolveScanAsset();
            if (this._scanCount % 7 === 1) {
                const matched = this._matchingPriceKeys(this._domAsset || '');
                let extra = matched.length ? ' | WS: [' + matched.join(', ') + ']' : ' | WS: -';
                if (scanAsset) {
                    const ctxInfo = this._getAnalysisContext(scanAsset);
                    extra += ' | свечи: ' + ctxInfo.candleCount + '/' + ctxInfo.minRequired +
                        ' | тики: ' + ctxInfo.tickCount;
                }
                const mood = this._sentiment[scanAsset] || this._sentiment[this._domAsset];
                let moodObj = mood;
                if (!moodObj && this._domAsset) {
                    const sk = Object.keys(this._sentiment);
                    for (let mi = 0; mi < sk.length; mi++) {
                        if (assetsMatch(sk[mi], this._domAsset) || (scanAsset && assetsMatch(sk[mi], scanAsset))) {
                            moodObj = this._sentiment[sk[mi]];
                            break;
                        }
                    }
                }
                if (moodObj && Date.now() - moodObj.ts < 20000) {
                    extra += ' | mood: ▲' + moodObj.up.toFixed(0) + '%/▼' + moodObj.down.toFixed(0) + '%';
                } else {
                    extra += ' | mood: -';
                    if (this._domAsset || scanAsset) subscribeSentiment(this._domAsset || scanAsset);
                }
                this.log('🔍 Скан: ' + (this._domAsset || '-') + ' -> ' + (scanAsset || '-') + extra);
            }

            const rawInd = this.config?.indicators;
            const indList = (Array.isArray(rawInd) && rawInd.length > 0) ? rawInd : [this.config?.indicator || 'RSI'];
            const mode = (this.config?.filterMode || 'ALL').toUpperCase();
            const onlySentiment = indList.length === 1 && String(indList[0]).toUpperCase() === 'SENTIMENT';

            if (!scanAsset) {
                const exp = parseInt(this.config?.expiration, 10) || 60;
                const prof = getAnalysisProfile(exp, this._analysisTimeframeSeconds());
                this._post('POROBOT_SCAN', { scan: {
                    asset: this._domAsset || '-',
                    filterMode: mode,
                    direction: 'NEUTRAL',
                    matchedCount: 0,
                    totalCount: indList.length,
                    indicators: indList.map(id => ({ id, signal: 'NEUTRAL' })),
                    priceCount: 0,
                    tickCount: 0,
                    minRequired: prof.minCandles,
                    candleSec: prof.candleSec,
                    ready: false
                }});
                return;
            }

            this._lastAsset = scanAsset;
            const ctx = this._getAnalysisContext(scanAsset);
            const sig = this._buildScanState(scanAsset, ctx);
            this._lastIndicatorByAsset = this._lastIndicatorByAsset || {};
            this._lastIndicatorByAsset[normalizeAssetName(scanAsset)] = { direction: sig.direction, timestamp: Date.now() };
            const displayAsset = (this._domAsset && assetsMatch(scanAsset, this._domAsset)) ? this._domAsset : (scanAsset || this._domAsset);
            this._logReject(displayAsset || scanAsset, sig);
            try {
                if (this.config && this.config.chartOverlay) PosChartOverlay.draw(this, ctx);
                else PosChartOverlay.clear();
            } catch (_) {}
            this._post('POROBOT_SCAN', { scan: {
                asset: displayAsset,
                wsAsset: scanAsset,
                filterMode: sig.filterMode,
                direction: sig.direction,
                matchedCount: sig.matchedCount,
                totalCount: sig.totalCount,
                indicators: sig.indicators,
                priceCount: ctx.candleCount,
                tickCount: ctx.tickCount,
                minRequired: ctx.minRequired,
                candleSec: ctx.candleSec,
                ready: ctx.ready || onlySentiment
            }});
            if(!ctx.ready && !onlySentiment) {
                this._maybeRequestHistory(false);
                return;
            }

            // ANY: по одной сделке на каждый совпавший фильтр
            if (sig.multiTrade) {
                this._handleAnyMultiTrades(scanAsset, sig);
                return;
            }

            if(sig.direction!=='UP'&&sig.direction!=='DOWN') return;
            const barTs = (ctx.candles && ctx.candles.length) ? ctx.candles[ctx.candles.length - 1].ts : 0;
            if (barTs && this._lastEntryBar === barTs) return;
            const expSec = parseInt(this.config?.expiration, 10) || 60;
            const cooldownMs = Math.max(15000, expSec * 1000);
            if(this._lastSignal===sig.direction && Date.now()-this._lastSignalTime < cooldownMs) return;
            if(this._tradeBusy) return;
            if (this.config?.autoTrade && frameHasTradeUI() && this._awaitingResult()) return;
            const bet = capBetToBalance(this.money.getNextBet());
            const expiration = parseInt(this.config?.expiration, 10) || 60;
            this._lastSignal=sig.direction; this._lastSignalTime=Date.now();
            this._lastEntryBar = barTs;
            this._post('POROBOT_SIGNAL',{signal:{
                asset: displayAsset || scanAsset,
                wsAsset: scanAsset,
                direction:sig.direction,
                amount:parseFloat(bet||1), indicator:sig.matchedIndicators,
                matchedCount:sig.matchedCount, totalCount:sig.totalCount,
                expiration: expiration, ts:Date.now()
            }});
            this.log(`📡 СИГНАЛ [${displayAsset}] ${sig.direction==='UP'?'▲ ВВЕРХ':'▼ ВНИЗ'} | ${sig.matchedCount}/${sig.totalCount} ${sig.filterMode || ''} | ${sig.matchedIndicators} | $${bet}${sig.confirmMode ? ' | ' + sig.confirmMode : ''}`);
            if (this.config?.autoTrade && frameHasTradeUI()) {
                const needed = parseFloat(bet) || 0;
                const info = getActiveBalanceInfo();
                if (info.balance != null && needed > 0 && info.balance + 1e-9 < needed) {
                    this.config.autoTrade = false;
                    this._post('POROBOT_AUTO_STOP', { reason: 'balance', balance: info.balance, needed: needed });
                    this.log('⛔ Недостаточно средств ($' + info.balance.toFixed(2) + ' < $' + needed.toFixed(2) + ') - автоторговля выключена');
                    return;
                }
                const self=this;
                const exp = parseInt(this.config?.expiration, 10) || 60;
                this._tradeBusy = true;
                this._tradeBusySince = Date.now();
                const tradeDirection = this._getTradeDirection(sig.direction);
                executeTrade(tradeDirection, bet, exp).then(function(ok) {
                    if (ok) self._addPending(1, exp);
                    self.log(ok ? '🤖 Авто-сделка: ' + (tradeDirection==='UP'?'CALL':'PUT') +
                        (tradeDirection !== sig.direction ? ' · REVERS' : '') + ' $' + bet + ' | ' + exp + 'с'
                        : '⚠️ Авто-сделка не удалась - проверьте экспирацию/кнопки PO');
                }).finally(function() {
                    self._tradeBusy = false;
                    self._tradeBusySince = 0;
                });
            }
        }

        _handleAnyMultiTrades(scanAsset, sig) {
            if (this._tradeBusy) return;
            if (this.config?.autoTrade && frameHasTradeUI() && this._awaitingResult()) return;
            const signals = Array.isArray(sig.multiSignals) ? sig.multiSignals : [];
            if (!signals.length) return;

            const ctx = this._getAnalysisContext(scanAsset);
            const barTs = (ctx.candles && ctx.candles.length) ? ctx.candles[ctx.candles.length - 1].ts : 0;
            if (barTs && this._lastEntryBar === barTs) return;

            const expSec = parseInt(this.config?.expiration, 10) || 60;
            // Кулдаун на индикатор: не спамим один и тот же фильтр, но разные фильтры могут стрелять сразу
            const cooldownMs = Math.max(12000, expSec * 1000);
            const now = Date.now();
            if (!this._indFireTime) this._indFireTime = {};

            const fresh = signals.filter(function(s) {
                const key = String(s.id).toUpperCase() + ':' + s.direction;
                const last = this._indFireTime[key] || 0;
                return (now - last) >= cooldownMs;
            }, this);

            if (!fresh.length) return;

            const bet = capBetToBalance(this.money.getNextBet());
            const expiration = expSec;
            const displayAsset = (this._domAsset && assetsMatch(scanAsset, this._domAsset)) ? this._domAsset : scanAsset;

            fresh.forEach(function(s) {
                this._indFireTime[String(s.id).toUpperCase() + ':' + s.direction] = now;
            }, this);

            this._lastSignal = sig.direction;
            this._lastSignalTime = now;
            this._lastEntryBar = barTs;

            const label = fresh.map(function(s) {
                return s.id + '=' + (s.direction === 'UP' ? '▲' : '▼');
            }).join(', ');

            this._post('POROBOT_SIGNAL', { signal: {
                asset: displayAsset,
                wsAsset: scanAsset,
                direction: sig.direction,
                amount: parseFloat(bet || 1),
                indicator: fresh.map(function(s) { return s.id; }).join('+'),
                matchedCount: fresh.length,
                totalCount: sig.totalCount,
                expiration: expiration,
                multiTrade: true,
                ts: now
            }});

            this.log('📡 ЛЮБОЙ [' + displayAsset + '] ' + fresh.length + ' сделок | ' + label + ' | $' + bet + ' каждая');

            if (!(this.config?.autoTrade && frameHasTradeUI())) return;

            const needed = parseFloat(bet) || 0;
            const balInfo = getActiveBalanceInfo();
            const totalNeeded = needed * fresh.length;
            if (balInfo.balance != null && totalNeeded > 0 && balInfo.balance + 1e-9 < needed) {
                this.config.autoTrade = false;
                this._post('POROBOT_AUTO_STOP', { reason: 'balance', balance: balInfo.balance, needed: needed });
                this.log('⛔ Недостаточно средств - автоторговля выключена');
                return;
            }

            const self = this;
            this._tradeBusy = true;
            this._tradeBusySince = Date.now();
            (async function() {
                try {
                    for (let i = 0; i < fresh.length; i++) {
                        if (!self.config?.autoTrade) break;
                        const live = getActiveBalanceInfo();
                        if (live.balance != null && needed > live.balance + 1e-9) {
                            self.config.autoTrade = false;
                            self._post('POROBOT_AUTO_STOP', { reason: 'balance', balance: live.balance, needed: needed });
                            self.log('⛔ Недостаточно средств на сделку #' + (i + 1) + ' - автоторговля выключена');
                            break;
                        }
                        const s = fresh[i];
                        const tradeDirection = self._getTradeDirection(s.direction);
                        const ok = await executeTrade(tradeDirection, bet, expiration);
                        if (ok) self._addPending(1, expiration);
                        self.log(ok
                            ? '🤖 Авто-сделка [' + s.id + ']: ' + (tradeDirection === 'UP' ? 'CALL' : 'PUT') +
                                (tradeDirection !== s.direction ? ' · REVERS' : '') + ' $' + bet + ' | ' + expiration + 'с'
                            : '⚠️ Авто-сделка [' + s.id + '] не удалась');
                        if (i < fresh.length - 1) await sleep(400);
                    }
                } finally {
                    self._tradeBusy = false;
                    self._tradeBusySince = 0;
                }
            })();
        }
    }

    if(!window.__poCore) window.__poCore=new QuotexCore();
    if (window.__PT4_PREDICTIVE_CONFIG && typeof window.__poCore.setPredictiveConfig === 'function') {
        window.__poCore.setPredictiveConfig(window.__PT4_PREDICTIVE_CONFIG);
    }

    function handleCoreCmd(d) {
        if (!d || !d.cmd) return;
        try {
            if (d.cmd === 'START') window.__poCore.start(d.config);
            if (d.cmd === 'STOP') window.__poCore.stop();
            if (d.cmd === 'SET_OVERLAY') {
                const on = !!d.enabled;
                const patch = d.patch || { chartOverlay: on };
                PosChartOverlay.setEnabled(on, patch);
            }
            if (d.cmd === 'PATCH_CONFIG' && d.patch) {
                if (!window.__poCore.config) window.__poCore.config = {};
                Object.assign(window.__poCore.config, d.patch);
                if (Object.prototype.hasOwnProperty.call(d.patch, 'reverseEnabled')) {
                    window.__poCore._reverseWinCount = 0;
                    if (!d.patch.reverseEnabled) window.__poCore._reverseMode = false;
                    window.__poCore.log(d.patch.reverseEnabled
                        ? '🔁 REVERS включён. Порог побед: ' + (parseInt(window.__poCore.config.reverseWins, 10) || 3)
                        : '🔁 REVERS выключен; сделки идут по исходным сигналам.');
                }
                if (Object.prototype.hasOwnProperty.call(d.patch, 'reverseWins')) {
                    window.__poCore._reverseWinCount = 0;
                    window.__poCore.log('🔁 REVERS: новый порог — ' + (parseInt(d.patch.reverseWins, 10) || 3) + ' побед подряд.');
                }
                if (Object.prototype.hasOwnProperty.call(d.patch, 'multiPairTrading')) {
                    if (d.patch.multiPairTrading) window.__poCore._startMultiPairTrading();
                    else window.__poCore.log('⏸ Мульти-пары выключены; уже открытые сделки продолжают отслеживаться.');
                } else if (window.__poCore.isRunning && window.__poCore.config.multiPairTrading &&
                    (Object.prototype.hasOwnProperty.call(d.patch, 'minProfit') || Object.prototype.hasOwnProperty.call(d.patch, 'includeOtc'))) {
                    window.__poCore._refreshMultiPairs(true);
                }
                // Смена системы ММ или её параметров на ходу: раньше менялся только config,
                // а MoneyManager считал по настройкам старта (мартингейл «не включался»).
                if (window.__poCore.money && MM_PATCH_KEYS.some(function(k) { return Object.prototype.hasOwnProperty.call(d.patch, k); })) {
                    const mmCore = window.__poCore;
                    const before = mmCore.money.strategy;
                    mmCore.money.configure(mmConfigFrom(mmCore.config), false);
                    if (before !== mmCore.money.strategy) {
                        mmCore._pendingTrades = [];
                        if (mmCore.isRunning) mmCore.log('💰 Мани-менеджмент: ' + mmCore.money.strategy + ' | ставка $' + mmCore.money.getNextBet());
                    }
                }
                if (Object.prototype.hasOwnProperty.call(d.patch, 'chartOverlay')) {
                    try {
                        PosChartOverlay.setEnabled(!!d.patch.chartOverlay, d.patch);
                    } catch (_) {}
                } else if (PosChartOverlay.enabled) {
                    // debounce через scheduleSync — не дёргать на каждый клик фильтра
                    try { PosChartOverlay.scheduleSync(false); } catch (_) {}
                }
                if (d.patch.expiration != null && frameHasTradeUI()) {
                    const sec = parseInt(d.patch.expiration, 10);
                    if (sec > 0) {
                        applyPlatformExpiration(sec, 5).then(function(ok) {
                            const core = window.__poCore;
                            if (core && ok) core._lastAppliedExp = sec;
                            if (!core || !core.isRunning) return;
                            if (ok) core.log('⏱ Экспирация на PO: ' + sec + 'с');
                            else core.log('⚠️ Не удалось переключить экспирацию на PO: ' + sec + 'с');
                        });
                    }
                }
                if (d.patch.baseBet != null && frameHasTradeUI()) {
                    const bet = capBetToBalance(d.patch.baseBet);
                    if (isFinite(bet) && bet > 0) {
                        const core = window.__poCore;
                        if (core) {
                            core._lastAppliedBet = bet;
                            if (core.money) {
                                core.money.baseBet = bet;
                                // новая база действует сразу, если серия прогрессии не в середине
                                if (!core.money._step) core.money.resetProgress();
                            }
                        }
                        applyPlatformBetAmount(bet, 5).then(function(ok) {
                            const core = window.__poCore;
                            if (!core || !core.isRunning) return;
                            if (ok) core.log('💵 Ставка на PO: $' + bet);
                            else core.log('⚠️ Не удалось установить ставку на PO: $' + bet);
                        });
                    }
                }
            }
        } catch (err) { console.error('[PocketOption Signal][CORE] cmd error', err); }
    }

    window.addEventListener('message', (e) => {
        const d = e.data;
        if (!d || d.type !== 'POROBOT_CORE_CMD') return;
        handleCoreCmd(d);
    });

    window.addEventListener('POROBOT_CORE_CMD', e => handleCoreCmd(e?.detail));

    window.addEventListener('POROBOT_RESULT_CMD', e=>{
        const d=e?.detail; if(!d||!d.result) return;
        try {
            const core=window.__poCore; if(!core||!core.isRunning) return;
            const profit=d.result==='WIN'?parseFloat((d.amount*0.85).toFixed(2)):-parseFloat(d.amount||1);
            core.onTradeResult({result:d.result,profit});
        } catch(err) {}
    });

    console.log('[PocketOption Signal] WebSocket interceptor ready.');

    // Always sync chart asset to UI (even when bot is stopped)
    let _lastUiAsset = '';
    function postChartAsset() {
        const a = readCurrentAssetFromDOM();
        if (!a || a === 'UNKNOWN') {
            const core = window.__poCore;
            const fallback = core && (core._domAsset || core._wsAsset);
            if (fallback && fallback !== _lastUiAsset) {
                _lastUiAsset = fallback;
                try { window.postMessage({ type: 'POROBOT_ASSET', asset: fallback }, '*'); } catch(_) {}
            }
            return;
        }
        const norm = normalizeAssetName(a);
        if (!looksLikeAsset(norm) || norm === _lastUiAsset) return;
        _lastUiAsset = norm;
        try { window.postMessage({ type: 'POROBOT_ASSET', asset: norm }, '*'); } catch(_) {}
    }
    postChartAsset();
    setInterval(postChartAsset, 800);

    let _lastBalancePost = '';
    let _lastPostedType = '';
    let _balanceWatchAttached = false;

    function postBalanceUpdate(force) {
        // Только top-frame: iframe часто держит устаревшие копии баланса и затирает UI
        try {
            if (window !== window.top) return;
        } catch (_) {
            // cross-origin top access denied - продолжаем (мы и есть изолированный контекст)
        }

        if (!shouldPostBalance() && !hasBalanceContext()) return;

        const info = getActiveBalanceInfo();
        if (info.balance == null && info.demo == null && info.real == null) return;

        let activeBal = info.balance;
        if (activeBal == null) {
            activeBal = info.type === 'real' ? info.real : info.demo;
        }
        if (activeBal == null) return;

        const demoBal = info.demo;
        const realBal = info.real;

        const key = (info.type || 'demo') + ':' + Number(activeBal).toFixed(2) + ':' +
            (demoBal != null ? Number(demoBal).toFixed(2) : '-') + ':' +
            (realBal != null ? Number(realBal).toFixed(2) : '-');
        const typeChanged = info.type !== _lastPostedType;
        if (!force && key === _lastBalancePost && !typeChanged) return;
        _lastBalancePost = key;
        _lastPostedType = info.type || _lastPostedType;

        try {
            window.postMessage({
                type: 'POROBOT_BALANCE',
                balance: activeBal,
                accountType: info.type || window._poLastWsAccountType || null,
                demoBalance: demoBal,
                realBalance: realBal,
                source: 'top-dom',
                ts: Date.now()
            }, '*');
        } catch (_) {}
    }

    postBalanceUpdate(true);
    setInterval(function() { postBalanceUpdate(true); }, 500);

    function watchBalanceDOM() {
        if (_balanceWatchAttached) return;
        const root = document.documentElement || document.body;
        if (!root) return;

        _balanceWatchAttached = true;
        let debounce = null;
        const schedule = function() {
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(function() { postBalanceUpdate(true); }, 40);
        };
        const obs = new MutationObserver(schedule);
        obs.observe(root, {
            attributes: true,
            attributeFilter: ['data-hd-show', 'data-hd-value', 'data-hd-status', 'data-balance', 'data-value', 'class', 'aria-selected', 'aria-current', 'style', 'title'],
            childList: true,
            subtree: true,
            characterData: true
        });
        document.addEventListener('click', schedule, true);
        document.addEventListener('visibilitychange', function() {
            if (!document.hidden) postBalanceUpdate(true);
        });
        // Повторные попытки, пока виджеты баланса появятся в SPA
        let tries = 0;
        const boot = setInterval(function() {
            tries++;
            postBalanceUpdate(true);
            if (shouldPostBalance() || tries > 40) clearInterval(boot);
        }, 500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', watchBalanceDOM);
    } else {
        watchBalanceDOM();
    }
    // На случай SPA-навигации
    setTimeout(watchBalanceDOM, 1000);
    setTimeout(watchBalanceDOM, 3000);

    window.addEventListener('pageshow', function() {
        _lastBalancePost = '';
        _lastPostedType = '';
        setTimeout(function() { postBalanceUpdate(true); }, 100);
        setTimeout(function() { postBalanceUpdate(true); }, 500);
        setTimeout(function() { postBalanceUpdate(true); }, 1500);
    });
})();
