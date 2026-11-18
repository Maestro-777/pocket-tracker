// Run from repository root: node Pocket-auto/tests/indicators.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'inject.js'), 'utf8');
const start = source.indexOf('    class CoreIndicators {');
const end = source.indexOf('\n    // ── Native chart indicators', start);
assert(start >= 0 && end > start, 'Could not locate CoreIndicators in inject.js');

const classSource = source.slice(start, end).trim();
// Isolate the pure indicator class from the browser-only extension bootstrap.
const CoreIndicators = new Function(classSource + '; return CoreIndicators;')();

function approx(actual, expected, tolerance = 1e-9) {
    assert(Number.isFinite(actual), 'Expected a finite number, got ' + actual);
    assert(Math.abs(actual - expected) <= tolerance,
        'Expected ' + expected + ', got ' + actual);
}

// RSI edge cases and a fixed Wilder-RSI reference fixture.
assert.strictEqual(CoreIndicators.rsi(Array(20).fill(10), 14), 50,
    'flat prices must produce neutral RSI 50');
assert.strictEqual(CoreIndicators.rsi(Array.from({ length: 16 }, (_, i) => i + 1), 14), 100,
    'only rising prices must produce RSI 100');
assert.strictEqual(CoreIndicators.rsi(Array.from({ length: 16 }, (_, i) => 16 - i), 14), 0,
    'only falling prices must produce RSI 0');
const rsiPrices = [
    100, 101, 100.5, 102, 101.2, 103, 102.3, 104, 102.8,
    105, 104.2, 106, 105.1, 107, 106, 108, 106.5, 109,
    107.8, 110, 108.9, 111, 109.7, 112, 110.2
];
approx(CoreIndicators.rsi(rsiPrices, 5), 55.407563711150935);

// MACD fixture verifies the EMA signal line and the complete first valid MACD point.
const macd = CoreIndicators.macd(rsiPrices, 3, 6, 3);
assert(macd, 'MACD should be available with enough input candles');
approx(macd.macd, 0.47764174305147833);
approx(macd.signal, 0.6320768726299812);
approx(macd.hist, -0.15443512957850292);
assert.strictEqual(CoreIndicators.macd(rsiPrices, 6, 3, 2), null,
    'MACD fast period must be shorter than slow period');

// The trend period is the number of full close-to-close intervals.
assert.strictEqual(CoreIndicators.trend([10, 2, 3, 4, 5, 9], 5), 'DOWN');
assert.strictEqual(CoreIndicators.trend([1, 2, 3, 4, 5], 5), 'NEUTRAL');

// %D needs k + d - 1 observations; a flat range should remain neutral at 50.
const flatCandles = Array.from({ length: 5 }, () => ({ high: 10, low: 10, close: 10 }));
const stoch = CoreIndicators.stochHL(flatCandles, 3, 3);
assert(stoch, 'stochastic should accept the minimum complete lookback');
assert.strictEqual(stoch.k, 50);
assert.strictEqual(stoch.d, 50);

// PSAR direction must follow the high/low swing, not an EMA/RSI proxy.
const risingCandles = Array.from({ length: 12 }, (_, i) => ({
    open: 10 + i, high: 11 + i, low: 9.5 + i, close: 10.5 + i
}));
const fallingCandles = Array.from({ length: 12 }, (_, i) => ({
    open: 20 - i, high: 20.5 - i, low: 18.5 - i, close: 19 - i
}));
assert.strictEqual(CoreIndicators.psar(risingCandles, 0.02, 0.2).direction, 'UP');
assert.strictEqual(CoreIndicators.psar(fallingCandles, 0.02, 0.2).direction, 'DOWN');
assert.strictEqual(CoreIndicators.psar(risingCandles, 0, 0.2), null);

console.log('Pocket-auto indicator tests passed.');
