(function(root) {
    'use strict';
    if (!root || root.__POS_STRATEGY_LAB__) return;

    const PARAMETER_SETS = [
        { id: 'fast', label: 'Fast', emaFast: 3, emaSlow: 10, macdFast: 8, macdSlow: 17, macdSignal: 6, trendPeriod: 3 },
        { id: 'quick', label: 'Quick', emaFast: 4, emaSlow: 14, macdFast: 10, macdSlow: 21, macdSignal: 7, trendPeriod: 4 },
        { id: 'balanced', label: 'Balanced', emaFast: 5, emaSlow: 18, macdFast: 12, macdSlow: 26, macdSignal: 9, trendPeriod: 5 },
        { id: 'slow', label: 'Slow', emaFast: 5, emaSlow: 21, macdFast: 12, macdSlow: 26, macdSignal: 9, trendPeriod: 7 }
    ];

    function candidates() {
        const modes = [
            { id: 'all3', label: 'Все 3', filters: ['EMA', 'MACD', 'TREND'], minVotes: 3 },
            { id: 'ema_macd', label: 'EMA + MACD', filters: ['EMA', 'MACD'], minVotes: 2 },
            { id: 'ema_trend', label: 'EMA + Trend', filters: ['EMA', 'TREND'], minVotes: 2 },
            { id: 'macd_trend', label: 'MACD + Trend', filters: ['MACD', 'TREND'], minVotes: 2 },
            { id: 'vote2', label: 'Большинство 2 из 3', filters: ['EMA', 'MACD', 'TREND'], minVotes: 2 }
        ];
        const out = [];
        PARAMETER_SETS.forEach(function(params) {
            modes.forEach(function(mode) {
                out.push({
                    id: params.id + '_' + mode.id,
                    name: params.label + ' · ' + mode.label,
                    params: params,
                    filters: mode.filters,
                    minVotes: mode.minVotes
                });
            });
        });
        return out;
    }

    function buildFeatures(candles, params, indicators) {
        const closes = candles.map(function(c) { return Number(c.close); });
        const features = new Array(candles.length);
        for (let i = 0; i < candles.length; i++) {
            const prefix = closes.slice(0, i + 1);
            const fast = indicators.ema(prefix, params.emaFast);
            const slow = indicators.ema(prefix, params.emaSlow);
            const macd = indicators.macd(prefix, params.macdFast, params.macdSlow, params.macdSignal);
            const trend = indicators.trend(prefix, params.trendPeriod);
            features[i] = {
                EMA: fast == null || slow == null ? 'NEUTRAL' : (fast > slow ? 'UP' : fast < slow ? 'DOWN' : 'NEUTRAL'),
                MACD: !macd ? 'NEUTRAL' : (macd.macd > macd.signal ? 'UP' : macd.macd < macd.signal ? 'DOWN' : 'NEUTRAL'),
                TREND: trend
            };
        }
        return features;
    }

    function directionFor(feature, candidate) {
        if (!feature) return null;
        let up = 0, down = 0;
        for (let i = 0; i < candidate.filters.length; i++) {
            const signal = feature[candidate.filters[i]];
            if (signal === 'UP') up++;
            else if (signal === 'DOWN') down++;
        }
        if (up === down || Math.max(up, down) < candidate.minVotes) return null;
        return up > down ? 'UP' : 'DOWN';
    }

    function contiguous(candles, from, to, candleMs) {
        for (let i = from; i < to; i++) {
            if ((Number(candles[i + 1].ts) - Number(candles[i].ts)) !== candleMs) return false;
        }
        return true;
    }

    function summarize(trades, payout) {
        let wins = 0, losses = 0, draws = 0, netUnits = 0;
        let losing = 0, maxLosing = 0;
        trades.forEach(function(trade) {
            if (trade.result === 'WIN') {
                wins++; netUnits += payout / 100; losing = 0;
            } else if (trade.result === 'LOSE') {
                losses++; netUnits -= 1; losing++;
                if (losing > maxLosing) maxLosing = losing;
            } else {
                draws++; losing = 0;
            }
        });
        const decided = wins + losses;
        const winRate = decided ? wins / decided * 100 : null;
        const expectancy = decided ? netUnits / decided : null;
        const profitFactor = losses ? (wins * payout / 100) / losses : (wins ? Infinity : null);
        let wilsonLower95 = null;
        if (decided) {
            const z = 1.96, p = wins / decided, z2 = z * z;
            const denominator = 1 + z2 / decided;
            const center = p + z2 / (2 * decided);
            const margin = z * Math.sqrt((p * (1 - p) / decided) + z2 / (4 * decided * decided));
            wilsonLower95 = Math.max(0, (center - margin) / denominator) * 100;
        }
        return {
            trades: trades.length, wins: wins, losses: losses, draws: draws, decided: decided,
            winRate: winRate, expectancy: expectancy, netUnits: netUnits,
            profitFactor: profitFactor, maxLosingStreak: maxLosing, wilsonLower95: wilsonLower95
        };
    }

    function backtestSplit(candles, features, candidate, startIndex, endExclusive, expiryBars, candleMs, expirationMs, payout, indicators) {
        const trades = [];
        const lastSignalAt = { UP: -Infinity, DOWN: -Infinity };
        let skippedGaps = 0, skippedCooldown = 0;
        const p = candidate.params;
        const warmup = Math.max(p.emaSlow, p.macdSlow + p.macdSignal - 1, p.trendPeriod + 1) - 1;

        for (let i = Math.max(startIndex, warmup); i + expiryBars < endExclusive; i++) {
            const direction = directionFor(features[i], candidate);
            if (!direction) continue;

            // One candidate can fire once per candle; same-side cooldown mirrors the live core.
            const signalAt = Number(candles[i].ts) + candleMs;
            if (signalAt - lastSignalAt[direction] < expirationMs) {
                skippedCooldown++;
                continue;
            }

            // Signal is known only after candle i closes. Entry is approximated at next open.
            // Exit is the close completing the requested number of full candle intervals.
            if (!contiguous(candles, i, i + expiryBars, candleMs)) {
                skippedGaps++;
                continue;
            }
            const entryPrice = Number(candles[i + 1].open);
            const exitPrice = Number(candles[i + expiryBars].close);
            if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice) || entryPrice <= 0 || exitPrice <= 0) continue;

            let result = 'DRAW';
            if ((direction === 'UP' && exitPrice > entryPrice) || (direction === 'DOWN' && exitPrice < entryPrice)) result = 'WIN';
            else if ((direction === 'UP' && exitPrice < entryPrice) || (direction === 'DOWN' && exitPrice > entryPrice)) result = 'LOSE';

            trades.push({
                signalAt: signalAt,
                entryAt: Number(candles[i + 1].ts),
                exitAt: Number(candles[i + expiryBars].ts) + candleMs,
                direction: direction, entryPrice: entryPrice, exitPrice: exitPrice, result: result
            });
            lastSignalAt[direction] = signalAt;
        }
        return {
            metrics: summarize(trades, payout),
            skippedGaps: skippedGaps,
            skippedCooldown: skippedCooldown
        };
    }

    function run(candles, config, indicators) {
        config = config || {};
        const candleSec = Math.floor(Number(config.candleSec));
        const expirationSec = Math.floor(Number(config.expiration));
        const payout = Number(config.payout);
        if (!indicators || typeof indicators.ema !== 'function' || typeof indicators.macd !== 'function' || typeof indicators.trend !== 'function') {
            return { status: 'error', message: 'Модуль индикаторов недоступен.' };
        }
        if (!Array.isArray(candles) || candles.length < 120) {
            return { status: 'error', message: 'Нужно минимум 120 настоящих OHLC-свечей для предварительного теста.' };
        }
        if (!Number.isFinite(candleSec) || candleSec < 3 || !Number.isFinite(expirationSec) ||
            expirationSec < candleSec || expirationSec % candleSec !== 0) {
            return { status: 'error', message: 'Экспирация должна быть целым числом выбранных свечных интервалов (например, 60с / S15 = 4 свечи).' };
        }
        if (!Number.isFinite(payout) || payout < 50 || payout > 100) {
            return { status: 'error', message: 'Выплата должна быть в диапазоне 50–100%.' };
        }

        const valid = candles.filter(function(c) {
            if (!c) return false;
            const o = Number(c.open), h = Number(c.high), l = Number(c.low), close = Number(c.close);
            return Number.isFinite(Number(c.ts)) && [o, h, l, close].every(Number.isFinite) &&
                o > 0 && close > 0 && h >= Math.max(o, close) && l <= Math.min(o, close) && h >= l;
        }).slice().sort(function(a, b) { return Number(a.ts) - Number(b.ts); });
        const unique = [];
        valid.forEach(function(c) {
            if (!unique.length || Number(c.ts) > Number(unique[unique.length - 1].ts)) unique.push(c);
        });
        if (unique.length < 120) {
            return { status: 'error', message: 'После проверки OHLC-структуры осталось меньше 120 корректных свечей.' };
        }

        const candleMs = candleSec * 1000;
        const expiryBars = expirationSec / candleSec;
        const splitIndex = Math.floor(unique.length * 0.70);
        const variants = candidates();
        const cache = {};
        const results = [];

        variants.forEach(function(candidate) {
            if (!cache[candidate.params.id]) cache[candidate.params.id] = buildFeatures(unique, candidate.params, indicators);
            const features = cache[candidate.params.id];
            const train = backtestSplit(unique, features, candidate, 0, splitIndex, expiryBars, candleMs, expirationSec * 1000, payout, indicators);
            const test = backtestSplit(unique, features, candidate, splitIndex, unique.length, expiryBars, candleMs, expirationSec * 1000, payout, indicators);
            results.push({
                id: candidate.id, name: candidate.name, filters: candidate.filters.join(' + '),
                params: candidate.params, minVotes: candidate.minVotes,
                train: train.metrics, test: test.metrics,
                trainSkippedGaps: train.skippedGaps, testSkippedGaps: test.skippedGaps,
                trainSkippedCooldown: train.skippedCooldown, testSkippedCooldown: test.skippedCooldown,
                trainScore: train.metrics.decided >= 20 ? train.metrics.expectancy : null
            });
        });

        // Ranking is trained on the first 70% only. The last 30% is a locked OOS check.
        results.sort(function(a, b) {
            const aScore = a.trainScore == null ? -Infinity : a.trainScore;
            const bScore = b.trainScore == null ? -Infinity : b.trainScore;
            if (bScore !== aScore) return bScore - aScore;
            return b.train.decided - a.train.decided;
        });
        let rank = 0;
        results.forEach(function(item) {
            item.trainRank = item.trainScore == null ? null : ++rank;
            item.testSampleAdequate = item.test.decided >= 50;
        });

        return {
            status: 'done', candleCount: unique.length, candleSec: candleSec,
            expirationSec: expirationSec, expiryBars: expiryBars, payout: payout,
            breakEvenWinRate: 100 / (1 + payout / 100),
            trainFraction: 70, trainCandles: splitIndex, testCandles: unique.length - splitIndex,
            fromTs: Number(unique[0].ts), toTs: Number(unique[unique.length - 1].ts),
            trainToTs: Number(unique[splitIndex - 1].ts), testFromTs: Number(unique[splitIndex].ts),
            entryModel: 'Сигнал после закрытия свечи → вход по open следующей свечи → выход по close через N полных интервалов',
            rankingBasis: 'Сортировка только по первым 70% истории; последние 30% не участвуют в выборе',
            strategies: results
        };
    }

    root.__POS_STRATEGY_LAB__ = { run: run, candidates: candidates, version: 1 };
})(typeof window !== 'undefined' ? window : null);
