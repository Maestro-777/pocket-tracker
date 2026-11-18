// Run from repository root: node Pocket-auto/tests/strategy-lab.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const injectSource = fs.readFileSync(path.join(__dirname, '..', 'inject.js'), 'utf8');
const indicatorStart = injectSource.indexOf('    class CoreIndicators {');
const indicatorEnd = injectSource.indexOf('\n    // ── Native chart indicators', indicatorStart);
assert(indicatorStart >= 0 && indicatorEnd > indicatorStart, 'Could not locate CoreIndicators');
const CoreIndicators = new Function(
    injectSource.slice(indicatorStart, indicatorEnd).trim() + '; return CoreIndicators;'
)();

const labSource = fs.readFileSync(path.join(__dirname, '..', 'strategy-lab.js'), 'utf8');
const labWindow = {};
new Function('window', labSource)(labWindow);
const lab = labWindow.__POS_STRATEGY_LAB__;
assert(lab && typeof lab.run === 'function', 'Strategy Lab module failed to initialize');

assert.strictEqual(lab.candidates().length, 20, 'expected 20 candidate strategies');

// Deterministic synthetic OHLC fixture: mixed short swings and a mild upward drift.
const candles = [];
let close = 1.10000;
const startTs = Date.UTC(2026, 0, 1);
for (let i = 0; i < 420; i++) {
    const open = close;
    const change = 0.000025 + 0.00022 * Math.sin(i / 6.7) + 0.00011 * Math.sin(i / 2.9);
    close = open + change;
    candles.push({
        ts: startTs + i * 15000,
        open: open,
        high: Math.max(open, close) + 0.00008,
        low: Math.min(open, close) - 0.00008,
        close: close
    });
}

const result = lab.run(candles, { candleSec: 15, expiration: 60, payout: 92 }, CoreIndicators);
assert.strictEqual(result.status, 'done');
assert.strictEqual(result.strategies.length, 20);
assert.strictEqual(result.candleCount, 420);
assert.strictEqual(result.trainCandles, 294);
assert.strictEqual(result.testCandles, 126);
assert.strictEqual(result.testFromTs, candles[294].ts);
assert(Math.abs(result.breakEvenWinRate - 52.0833333333) < 1e-8);
assert(result.strategies.some(s => s.train.decided > 0), 'training segment should produce candidate trades');
assert(result.strategies.some(s => s.test.decided > 0), 'OOS segment should produce candidate trades');

for (let i = 1; i < result.strategies.length; i++) {
    const prev = result.strategies[i - 1].trainScore;
    const cur = result.strategies[i].trainScore;
    if (prev != null && cur != null) assert(prev >= cur, 'candidate ranking must use descending TRAIN expectancy');
}

result.strategies.forEach(function(strategy) {
    if (strategy.train.decided >= 20) assert(strategy.trainRank != null);
    else assert.strictEqual(strategy.trainRank, null);
    assert.strictEqual(strategy.testSampleAdequate, strategy.test.decided >= 50);
});

// Mutating only the later OOS candles must not change any TRAIN metrics or TRAIN ranks.
const split = result.trainCandles;
const changedOos = candles.map(function(c, i) {
    if (i < split) return Object.assign({}, c);
    const open = c.open + 0.002;
    const close = c.close + 0.0025;
    return {
        ts: c.ts,
        open: open,
        high: Math.max(open, close) + 0.00008,
        low: Math.min(open, close) - 0.00008,
        close: close
    };
});
const changedResult = lab.run(changedOos, { candleSec: 15, expiration: 60, payout: 92 }, CoreIndicators);
const baselineById = new Map(result.strategies.map(s => [s.id, s]));
changedResult.strategies.forEach(function(strategy) {
    const baseline = baselineById.get(strategy.id);
    assert.deepStrictEqual(strategy.train, baseline.train, 'OOS data must not alter TRAIN metrics for ' + strategy.id);
    assert.strictEqual(strategy.trainRank, baseline.trainRank, 'OOS data must not alter TRAIN ranking for ' + strategy.id);
});

assert.strictEqual(
    lab.run(candles, { candleSec: 15, expiration: 60, payout: 101 }, CoreIndicators).status,
    'error',
    'payout outside supported range must fail closed'
);
assert.strictEqual(
    lab.run(candles, { candleSec: 15, expiration: 50, payout: 92 }, CoreIndicators).status,
    'error',
    'expiration must be a whole number of candles'
);

console.log('Pocket-auto Strategy Lab tests passed (20 strategies, chronological 70/30 split, OOS isolation).');
