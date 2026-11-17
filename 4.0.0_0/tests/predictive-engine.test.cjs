'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'predictive-engine.js'), 'utf8');

function makeEngine(options = {}) {
  const listeners = {}, posted = [];
  const window = {
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    postMessage(message) { posted.push(message); },
    __listeners: listeners
  };
  window.window = window;
  vm.runInNewContext(source, { window, console, Date, Math, Map, Set, Object, Array, Number, String, JSON });
  const Engine = window.PT4PredictiveEngine;
  const engine = new Engine(options);
  return { engine, window, listeners, posted };
}

function tick(engine, asset, timestamp, price) {
  return engine.ingest({ asset, timestamp, price });
}

test('rejects non-OTC quotes and malformed prices', () => {
  const { engine } = makeEngine();
  assert.equal(tick(engine, 'EURUSD', 1000, 1.1), null);
  assert.equal(tick(engine, 'EURUSD_otc', 1000, NaN), null);
  assert.equal(engine.series.size, 0);
});

test('creates five immutable-horizon forecasts with all six models', () => {
  const { engine } = makeEngine({ minSamples: 30 });
  let forecast;
  for (let i = 1; i <= 40; i++) {
    forecast = tick(engine, 'EURUSD_otc', i * 1000, 1.1 + i * 0.00001 + Math.sin(i / 3) * 0.00002);
  }
  assert.ok(forecast);
  assert.deepEqual(Object.keys(forecast.horizons).sort(), ['120','180','240','300','60']);
  for (const horizon of [60,120,180,240,300]) {
    const row = forecast.horizons[horizon];
    for (const model of ['linear','exponential','polynomial','momentum','cyclical','ensemble']) {
      assert.ok(Number.isFinite(row.models[model]), model + ' must produce a finite price');
      assert.equal(row.modelConfidence[model], 0.5, model + ' must start with neutral confidence');
      assert.equal(row.modelEligible[model], false, model + ' must not be eligible before evidence');
    }
    assert.equal(row.confidence, 0.5, 'untrained model confidence must remain neutral');
    assert.equal(row.eligible, false, 'untrained forecast must not pass default confidence floor');
  }
  const pending = engine.getPending()[0];
  const frozen = pending.predicted;
  for (let i = 41; i <= 45; i++) tick(engine, 'EURUSD_otc', i * 1000, 1.2 + i * 0.00001);
  assert.equal(engine.getPending().find(x => x.id === pending.id).predicted, frozen);
});


test('selects different empirically validated models per asset and horizon', () => {
  const { engine } = makeEngine({ minSamples: 30, confidenceFloor: 0.60, minEvaluationSamples: 30 });
  for (let i = 1; i <= 39; i++) tick(engine, 'EURUSD_otc', i * 1000, 1.1 + i * 0.00001 + Math.sin(i / 3) * 0.00001);
  const good = { n:30, decisive:30, wins:30, losses:0, draws:0, mae:0.0001, brier:0, lastUpdatedAt:39000 };
  engine.stats.set('EURUSD_OTC|60|linear', Object.assign({}, good));
  engine.stats.set('EURUSD_OTC|120|exponential', Object.assign({}, good));
  const forecast = tick(engine, 'EURUSD_otc', 40000, 1.1004);
  assert.equal(forecast.horizons[60].model, 'linear');
  assert.equal(forecast.horizons[120].model, 'exponential');
  assert.equal(forecast.horizons[60].modelConfidenceSamples.linear, 30);
  assert.ok(forecast.horizons[60].modelConfidence.linear > 0.60);
  assert.equal(forecast.horizons[60].modelEligible.linear, true);
});

test('settles forecasts only at/after expiry and records model outcomes', () => {
  const { engine, posted } = makeEngine({ minSamples: 30, maxSettlementDelayMs: 15000 });
  for (let i = 1; i <= 40; i++) tick(engine, 'GBPUSD_otc', i * 1000, 1.25 + i * 0.00001);
  const first = engine.getPending().find(x => x.horizon === 60);
  assert.ok(first);
  let settled = null;
  engine.onUpdate((type, payload) => { if (type === 'settled' && payload.id === first.id) settled = payload; });
  tick(engine, 'GBPUSD_otc', first.dueAt, first.entry + 0.0005);
  assert.ok(settled);
  assert.equal(settled.status, 'SETTLED');
  assert.equal(settled.actualDirection, 'UP');
  assert.equal(settled.modelResults.ensemble.correct, true);
  assert.ok(posted.some(x => x.type === 'POROBOT_PREDICTIVE_EVENT' && x.eventType === 'settlement_batch'));
  assert.equal(posted.some(x => x.type === 'POROBOT_PREDICTIVE_EVENT' && x.eventType === 'settled'), false);
  const stats = engine.getStats('GBPUSD_otc');
  assert.ok(stats.some(x => x.model === 'ensemble' && x.decisiveSamples === 1));
});

test('marks a forecast invalid when the first available quote is too late', () => {
  const { engine } = makeEngine({ minSamples: 30, maxSettlementDelayMs: 15000 });
  for (let i = 1; i <= 40; i++) tick(engine, 'USDJPY_otc', i * 1000, 150 + i * 0.001);
  const first = engine.getPending().find(x => x.horizon === 60);
  let invalid = null;
  engine.onUpdate((type, payload) => { if (type === 'invalid' && payload.id === first.id) invalid = payload; });
  tick(engine, 'USDJPY_otc', first.dueAt + 16000, 151);
  assert.ok(invalid);
  assert.equal(invalid.status, 'INVALID_LATE_TICK');
});

test('exports and restores pending forecasts, price history and model statistics', () => {
  const first = makeEngine({ minSamples: 30 });
  for (let i = 1; i <= 40; i++) tick(first.engine, 'AUDUSD_otc', i * 1000, 0.65 + i * 0.00001);
  const snapshot = first.engine.exportState();
  const second = makeEngine();
  assert.equal(second.engine.restoreState(snapshot), true);
  assert.equal(second.engine.getPending().length, first.engine.getPending().length);
  assert.equal(second.engine.series.get('AUDUSD_OTC').length, 40);
});


test('draw outcomes are tracked separately and excluded from directional accuracy', () => {
  const { engine } = makeEngine({ minSamples: 30 });
  for (let i = 1; i <= 30; i++) tick(engine, 'NZDUSD_otc', i * 1000, 0.61 + i * 0.00001);
  const first = engine.getPending().find(x => x.horizon === 60);
  tick(engine, 'NZDUSD_otc', first.dueAt, first.entry);
  const rows = engine.getStats('NZDUSD_otc');
  assert.ok(rows.filter(x => x.samples > 0).every(x => x.draws === 1 && x.decisiveSamples === 0 && x.accuracy === null));
});

test('manifest and UI are wired to the existing MAIN-world quote injector', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const main = manifest.content_scripts.find(x => x.world === 'MAIN');
  assert.ok(main);
  assert.deepEqual(main.js.slice(0, 2), ['predictive-engine.js', 'inject.js']);
  const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  const injector = fs.readFileSync(path.join(root, 'inject.js'), 'utf8');
  assert.match(content, /data-tab="predictive"/);
  assert.match(content, /POROBOT_PREDICTIVE_EVENT/);
  assert.match(injector, /onPredictiveForecast\(forecast\)/);
  assert.match(injector, /_openPredictiveOrder\(signal, cfg\)/);
  assert.match(injector, /_refreshMultiPairs\(force, predictiveOnly\)/);
  assert.match(injector, /POROBOT_PREDICTIVE_ASSETS/);
  assert.match(injector, /const tradeDirection = signal.direction/);
  assert.match(injector, /if \(trade.source !== 'predictive'\) this\._recordReverseResult\(result\)/);
  const predictiveTrade = injector.slice(injector.indexOf('_openPredictiveOrder(signal, cfg)'), injector.indexOf('_scanMultiPairs()'));
  assert.doesNotMatch(predictiveTrade, /realTradeConfirmed|confirmReal/);
  assert.match(predictiveTrade, /accountType !== cfg.accountMode/);
  assert.match(injector, /if \(this\._isPredictiveModeExclusive\(\) \|\| !\(this\.config\?\.autoTrade && frameHasTradeUI\(\)\)\) return;/);
  assert.match(injector, /if \(!this\.config\.autoTrade \|\| this\._isPredictiveModeExclusive\(\)\) continue;/);
});


test('clears stale model warm-up after a prolonged quote interruption', () => {
  const { engine, posted } = makeEngine({ minSamples: 30 });
  for (let i = 1; i <= 30; i++) tick(engine, 'EURCHF_otc', i * 1000, 0.95 + i * 0.00001);
  assert.equal(engine.series.get('EURCHF_OTC').length, 30);
  tick(engine, 'EURCHF_otc', 61000, 0.951);
  assert.equal(engine.series.get('EURCHF_OTC').length, 1);
  const warmup = posted.filter(x => x.type === 'POROBOT_PREDICTIVE_WARMUP').slice(-1)[0];
  assert.equal(warmup.samples, 1);
  assert.equal(warmup.price, 0.951);
});

test('ignores out-of-order and duplicate timestamps', () => {
  const { engine } = makeEngine({ minSamples: 30 });
  assert.ok(tick(engine, 'EURGBP_otc', 1000, 0.85) === null);
  assert.equal(tick(engine, 'EURGBP_otc', 1000, 0.86), null);
  assert.equal(tick(engine, 'EURGBP_otc', 900, 0.87), null);
  assert.equal(engine.series.get('EURGBP_OTC').length, 1);
});
