/* Pocket Tracker 4.0 — Predictive Chart Engine
 * OTC-only quote consumer. Forecasts are frozen at issue time and evaluated
 * only against the first valid quote at/after their expiry.
 */
(function (root) {
  'use strict';
  if (root.PT4PredictiveEngine) return;

  const HORIZONS = [60, 120, 180, 240, 300];
  const MODEL_IDS = ['linear', 'exponential', 'polynomial', 'momentum', 'cyclical', 'ensemble'];
  const BASE_MODELS = MODEL_IDS.filter(id => id !== 'ensemble');
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
  const variance = a => { const m = mean(a); return mean(a.map(x => (x - m) ** 2)); };
  const signDirection = (a, b, epsilon) => Math.abs(a - b) <= epsilon ? 'DRAW' : (a > b ? 'UP' : 'DOWN');

  function solve3(matrix, vector) {
    const a = matrix.map((row, i) => row.concat(vector[i]));
    for (let col = 0; col < 3; col++) {
      let pivot = col;
      for (let row = col + 1; row < 3; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
      if (Math.abs(a[pivot][col]) < 1e-12) return null;
      [a[col], a[pivot]] = [a[pivot], a[col]];
      const div = a[col][col];
      for (let j = col; j < 4; j++) a[col][j] /= div;
      for (let row = 0; row < 3; row++) {
        if (row === col) continue;
        const factor = a[row][col];
        for (let j = col; j < 4; j++) a[row][j] -= factor * a[col][j];
      }
    }
    return [a[0][3], a[1][3], a[2][3]];
  }

  class PredictiveEngine {
    constructor(options = {}) {
      this.options = Object.assign({
        enabled: true, minSamples: 80, maxTicks: 12000, maxForecasts: 10000,
        confidenceFloor: 0.52, forecastIntervalMs: 5000,
        minEvaluationSamples: 30, maxSettlementDelayMs: 15000,
        maxProjectionVolatility: 4, drawEpsilon: 1e-10
      }, options);
      this.series = new Map();
      this.pending = new Map();
      this.history = [];
      this.listeners = new Set();
      this.stats = new Map();
      this.lastForecastAt = new Map();
    }
    onUpdate(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(type, data, broadcast = true) {
      for (const fn of this.listeners) { try { fn(type, data); } catch (_) {} }
      if (!broadcast) return;
      try {
        const now = Date.now();
        const includeState = type !== 'forecast' || now - (this._lastStateExportAt || 0) >= 5000;
        const message = { type: 'POROBOT_PREDICTIVE_EVENT', eventType: type, payload: data };
        if (includeState) { message.state = this.exportState(); this._lastStateExportAt = now; }
        root.postMessage(message, '*');
      } catch (_) {}
    }
    exportState() {
      return {
        version: 1, savedAt: Date.now(),
        series: Array.from(this.series.entries()).map(([asset, ticks]) => [asset, ticks.slice(-300)]),
        pending: Array.from(this.pending.values()).slice(-this.options.maxForecasts),
        stats: Array.from(this.stats.entries()), history: this.history.slice(-500),
        options: Object.assign({}, this.options)
      };
    }
    restoreState(snapshot) {
      if (!snapshot || snapshot.version !== 1) return false;
      const validAsset = asset => typeof asset === 'string' && this._isOtc(asset);
      if (Array.isArray(snapshot.series)) {
        for (const row of snapshot.series.slice(-100)) {
          if (!Array.isArray(row) || !validAsset(row[0]) || !Array.isArray(row[1])) continue;
          const ticks = row[1].filter(x => x && Number.isFinite(Number(x.t)) && Number(x.p) > 0)
            .map(x => ({ t: Number(x.t), p: Number(x.p) })).sort((a,b) => a.t-b.t).slice(-300);
          if (ticks.length) this.series.set(this._key(row[0]), ticks);
        }
      }
      if (Array.isArray(snapshot.stats)) {
        for (const row of snapshot.stats.slice(-10000)) {
          if (!Array.isArray(row) || typeof row[0] !== 'string' || !row[1] || typeof row[1] !== 'object') continue;
          const parts = row[0].split('|');
          if (parts.length !== 3 || !validAsset(parts[0]) || !HORIZONS.includes(Number(parts[1])) || !MODEL_IDS.includes(parts[2])) continue;
          const v = row[1];
          const numeric = ['n','decisive','wins','losses','draws','mae','brier','lastUpdatedAt'];
          if (numeric.some(k => !Number.isFinite(Number(v[k])) || Number(v[k]) < 0)) continue;
          this.stats.set(row[0], Object.fromEntries(numeric.map(k => [k, Number(v[k])] )));
        }
      }
      if (Array.isArray(snapshot.pending)) {
        for (const item of snapshot.pending.slice(-this.options.maxForecasts)) {
          if (!item || !validAsset(item.asset) || !HORIZONS.includes(Number(item.horizon)) || !Number.isFinite(Number(item.dueAt)) || !(Number(item.entry)>0) || !item.models || !item.modelDirections || !item.modelProbabilities) continue;
          this.pending.set(String(item.id), item);
        }
      }
      if (Array.isArray(snapshot.history)) this.history = snapshot.history.filter(x => x && validAsset(x.asset)).slice(-this.options.maxForecasts);
      if (snapshot.options && typeof snapshot.options === 'object') this.setOptions(snapshot.options);
      return true;
    }
    _key(asset) { return String(asset || '').trim().toUpperCase(); }
    _isOtc(asset) { return /(?:_OTC| OTC)$/i.test(String(asset || '').trim()); }
    _statKey(asset, horizon, model) { return asset + '|' + horizon + '|' + model; }
    _stat(asset, horizon, model) {
      const key = this._statKey(asset, horizon, model);
      if (!this.stats.has(key)) this.stats.set(key, {
        n: 0, decisive: 0, wins: 0, losses: 0, draws: 0,
        mae: 0, brier: 0, lastUpdatedAt: 0
      });
      return this.stats.get(key);
    }
    ingest(tick) {
      if (!this.options.enabled || !tick || !this._isOtc(tick.asset)) return null;
      const asset = this._key(tick.asset);
      const price = Number(tick.price);
      const timestamp = Number(tick.timestamp) || Date.now();
      if (!(price > 0) || !Number.isFinite(price) || !Number.isFinite(timestamp)) return null;
      let series = this.series.get(asset);
      if (!series) { series = []; this.series.set(asset, series); }
      const last = series[series.length - 1];
      if (last && timestamp <= last.t) return null;
      if (last && timestamp - last.t > 30000) { series.length = 0; this.lastForecastAt.delete(asset); }
      series.push({ t: timestamp, p: price });
      if (series.length > this.options.maxTicks) series.splice(0, series.length - this.options.maxTicks);
      this._settle(asset, timestamp, price);
      if (series.length < this.options.minSamples) return null;
      return this.forecast(asset, timestamp);
    }
    _returns(series) {
      const out = [];
      for (let i = 1; i < series.length; i++) {
        const dt = (series[i].t - series[i - 1].t) / 1000;
        if (!(dt > 0) || dt > 30) continue;
        const r = Math.log(series[i].p / series[i - 1].p);
        if (Number.isFinite(r)) out.push({ t: series[i].t, r, dt });
      }
      return out;
    }
    _features(series) {
      const recent = series.slice(-240);
      const returns = this._returns(recent);
      const rates = returns.map(x => x.r / x.dt);
      const tail = rates.slice(-60);
      const center = mean(tail);
      const deviations = tail.map(x => Math.abs(x - center)).sort((a, b) => a - b);
      const mad = deviations.length ? deviations[Math.floor(deviations.length * 0.5)] : 0;
      const cap = Math.max(mad * 4, 1e-10);
      const robust = rates.map(x => clamp(x, center - cap, center + cap));
      const fast = mean(robust.slice(-10));
      const slow = mean(robust.slice(-40));
      const first = mean(robust.slice(-40, -20));
      const volatility = Math.sqrt(variance(robust.slice(-60)));
      return { recent, returns, rates: robust, velocity: fast, acceleration: fast - first, momentum: fast * 0.65 + slow * 0.35, volatility };
    }
    _linear(series, horizonSeconds, features) {
      const p = series[series.length - 1].p;
      const sample = series.slice(-120);
      const t0 = sample[0].t;
      const xs = sample.map(x => (x.t - t0) / 1000);
      const ys = sample.map(x => Math.log(x.p / p));
      const mx = mean(xs), my = mean(ys);
      const denom = mean(xs.map(x => (x - mx) ** 2));
      const slope = denom ? mean(xs.map((x, i) => (x - mx) * (ys[i] - my))) / denom : 0;
      const mid = Math.floor(sample.length / 2);
      const half = sample.slice(mid);
      const hx = half.map(x => (x.t - half[0].t) / 1000);
      const hy = half.map(x => Math.log(x.p / p));
      const hmx = mean(hx), hmy = mean(hy);
      const hden = mean(hx.map(x => (x - hmx) ** 2));
      const recentSlope = hden ? mean(hx.map((x, i) => (x - hmx) * (hy[i] - hmy))) / hden : slope;
      const accelerationLimit = Math.max(1e-10, features.volatility * 2 / Math.max(1, horizonSeconds));
      const acceleration = clamp((recentSlope - slope) / Math.max(1, horizonSeconds), -accelerationLimit, accelerationLimit);
      const projected = slope * horizonSeconds + 0.5 * acceleration * horizonSeconds * horizonSeconds;
      return p * Math.exp(clamp(projected, -0.05, 0.05));
    }
    _exponential(series, horizonSeconds) {
      const values = series.slice(-180).map(x => x.p);
      if (values.length < 3) return values[values.length - 1];
      const alpha = 0.22, beta = 0.12;
      let level = values[0], trend = values[1] - values[0];
      for (let i = 1; i < values.length; i++) {
        const previous = level;
        level = alpha * values[i] + (1 - alpha) * (level + trend);
        trend = beta * (level - previous) + (1 - beta) * trend;
      }
      const avgInterval = Math.max(0.05, (series[series.length - 1].t - series[Math.max(0, series.length - values.length)].t) / 1000 / (values.length - 1));
      return level + trend * (horizonSeconds / avgInterval);
    }
    _polynomial(series, horizonSeconds) {
      const sample = series.slice(-50);
      if (sample.length < 6) return this._exponential(series, horizonSeconds);
      const now = sample[sample.length - 1].t;
      const xs = sample.map(x => (x.t - now) / 1000);
      const ys = sample.map(x => Math.log(x.p));
      const scale = Math.max(1, Math.abs(xs[0]));
      const z = xs.map(x => x / scale);
      const s0 = z.length, s1 = z.reduce((a, x) => a + x, 0);
      const s2 = z.reduce((a, x) => a + x*x, 0), s3 = z.reduce((a, x) => a + x*x*x, 0);
      const s4 = z.reduce((a, x) => a + x*x*x*x, 0);
      const sy = ys.reduce((a, x) => a + x, 0);
      const sxy = z.reduce((a, x, i) => a + x*ys[i], 0);
      const sx2y = z.reduce((a, x, i) => a + x*x*ys[i], 0);
      const ridge = 1e-7 * s0;
      const coeff = solve3([[s0,s1,s2],[s1,s2,s3],[s2,s3,s4+ridge]],[sy,sxy,sx2y]);
      if (!coeff) return this._exponential(series, horizonSeconds);
      const future = horizonSeconds / scale;
      const logPrice = coeff[0] + coeff[1]*future + coeff[2]*future*future;
      return Math.exp(clamp(logPrice, Math.log(sample[sample.length-1].p)-0.05, Math.log(sample[sample.length-1].p)+0.05));
    }
    _momentum(series, horizonSeconds, features) {
      const r = features.returns.slice(-50).map(x => x.r / x.dt);
      const fast = mean(r.slice(-8)), slow = mean(r);
      const damp = Math.exp(-horizonSeconds / 240);
      return series[series.length-1].p * Math.exp(clamp((fast*0.7 + slow*0.3) * horizonSeconds * damp, -0.05, 0.05));
    }
    _cyclical(series, horizonSeconds, features) {
      const r = features.returns.slice(-100).map(x => x.r);
      if (r.length < 18) return series[series.length-1].p;
      const centered = r.map(x => x - mean(r));
      let bestLag = 0, bestCorr = 0;
      for (let lag = 3; lag <= Math.min(35, Math.floor(r.length/3)); lag++) {
        let cross = 0, aa = 0, bb = 0;
        for (let i = lag; i < centered.length; i++) {
          cross += centered[i] * centered[i-lag];
          aa += centered[i] * centered[i];
          bb += centered[i-lag] * centered[i-lag];
        }
        const corr = aa && bb ? cross / Math.sqrt(aa*bb) : 0;
        if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
      }
      if (!bestLag || bestCorr < 0.12) return series[series.length-1].p;
      const periodSeconds = bestLag * mean(features.returns.slice(-bestLag).map(x => x.dt));
      const phase = (horizonSeconds / Math.max(0.1, periodSeconds)) * Math.PI * 2;
      const amplitude = mean(centered.slice(-bestLag).map(Math.abs)) * Math.sqrt(bestLag);
      const direction = Math.sign(mean(centered.slice(-Math.max(2, Math.floor(bestLag/2)))));
      const move = direction * amplitude * Math.sin(phase) * Math.exp(-horizonSeconds/300);
      return series[series.length-1].p * Math.exp(clamp(move, -0.03, 0.03));
    }
    _predictAll(series, horizonSeconds, asset) {
      const features = this._features(series);
      const predictions = {
        linear: this._linear(series, horizonSeconds, features),
        exponential: this._exponential(series, horizonSeconds),
        polynomial: this._polynomial(series, horizonSeconds),
        momentum: this._momentum(series, horizonSeconds, features),
        cyclical: this._cyclical(series, horizonSeconds, features)
      };
      for (const id of BASE_MODELS) {
        if (!(predictions[id] > 0) || !Number.isFinite(predictions[id])) delete predictions[id];
      }
      const rankedBase = BASE_MODELS.filter(id => predictions[id] > 0).map(id => ({
        id, score: this._score(asset, horizonSeconds, id)
      })).sort((a,b) => a.score - b.score);
      const eligibleBase = rankedBase.filter(x => {
        const st = this.stats.get(this._statKey(asset, horizonSeconds, x.id));
        return st && st.decisive >= this.options.minEvaluationSamples;
      });
      const chosen = (eligibleBase.length ? eligibleBase : rankedBase).slice(0, eligibleBase.length ? 3 : rankedBase.length);
      const weights = chosen.map(x => {
        const st = this.stats.get(this._statKey(asset, horizonSeconds, x.id));
        return st && st.decisive >= this.options.minEvaluationSamples ? 1 / Math.max(0.02, x.score) : 1;
      });
      if (chosen.length) predictions.ensemble = chosen.reduce((sum, x, i) => sum + predictions[x.id] * weights[i], 0) / weights.reduce((a,b)=>a+b,0);
      const ranked = Object.keys(predictions).map(id => ({ id, score: this._score(asset, horizonSeconds, id) })).sort((a,b) => a.score - b.score);
      return { predictions, ranked, features };
    }
    _score(asset, horizonSeconds, model) {
      const st = this.stats.get(this._statKey(asset, horizonSeconds, model));
      if (!st || st.decisive < this.options.minEvaluationSamples) return Infinity;
      const accuracyError = 1 - st.wins / st.decisive;
      const brier = st.brier / st.decisive;
      return 0.7 * accuracyError + 0.3 * brier;
    }
    _confidence(asset, horizonSeconds, model, predicted, current, features) {
      const st = this.stats.get(this._statKey(asset, horizonSeconds, model));
      if (!st || st.decisive < this.options.minEvaluationSamples) {
        return { value: 0.5, samples: st ? st.decisive : 0, calibrated: false };
      }
      const n = st.decisive, p = st.wins/n, z = 1.96;
      const lower = (p + z*z/(2*n) - z*Math.sqrt((p*(1-p)+z*z/(4*n))/n))/(1+z*z/n);
      return { value: clamp(lower, 0.5, 0.99), samples: n, calibrated: true };
    }
    forecast(asset, now = Date.now()) {
      asset = this._key(asset);
      const series = this.series.get(asset);
      if (!series || series.length < this.options.minSamples) return null;
      const previous = this.lastForecastAt.get(asset) || 0;
      if (now - previous < this.options.forecastIntervalMs) return null;
      this.lastForecastAt.set(asset, now);
      const current = series[series.length-1].p, horizons = {};
      for (const horizon of HORIZONS) {
        const { predictions, ranked, features } = this._predictAll(series, horizon, asset);
        const eligible = ranked.filter(x => {
          const st = this.stats.get(this._statKey(asset, horizon, x.id));
          return st && st.decisive >= this.options.minEvaluationSamples;
        });
        const selected = eligible.length ? eligible[0].id : 'ensemble';
        const target = predictions[selected] || predictions.ensemble || current;
        const direction = signDirection(target, current, this.options.drawEpsilon * current);
        const modelConfidence = {}, modelEligible = {};
        for (const id of Object.keys(predictions)) {
          const modelConf = this._confidence(asset, horizon, id, predictions[id], current, features);
          modelConfidence[id] = modelConf.value;
          modelEligible[id] = modelConf.value >= this.options.confidenceFloor;
        }
        const confidence = this._confidence(asset, horizon, selected, target, current, features);
        const forecastId = asset + '|' + horizon + '|' + now;
        const modelDirections = {}, modelProbabilities = {};
        const horizonNoise = Math.max(1e-8, features.volatility * Math.sqrt(horizon));
        for (const id of Object.keys(predictions)) {
          const modelMove = Math.log(predictions[id] / current);
          modelDirections[id] = signDirection(predictions[id], current, this.options.drawEpsilon * current);
          modelProbabilities[id] = 1 / (1 + Math.exp(-clamp(2 * modelMove / horizonNoise, -20, 20)));
        }
        const row = {
          horizonSeconds: horizon, price: target, direction, model: selected,
          confidence: confidence.value, confidenceSamples: confidence.samples,
          confidenceCalibrated: false, confidenceEvidenceBased: confidence.calibrated,
          eligible: confidence.value >= this.options.confidenceFloor,
          models: Object.assign({}, predictions), modelDirections, modelProbabilities,
          modelConfidence, modelEligible
        };
        horizons[horizon] = row;
        this.pending.set(forecastId, {
          id: forecastId, asset, horizon, issuedAt: now, dueAt: now + horizon*1000,
          entry: current, predicted: target, direction, model: selected,
          models: Object.assign({}, predictions), modelDirections, modelProbabilities
        });
      }
      while (this.pending.size > this.options.maxForecasts) {
        const oldestId = this.pending.keys().next().value;
        const dropped = this.pending.get(oldestId);
        this.pending.delete(oldestId);
        if (dropped) this.history.push(Object.assign({}, dropped, { status: 'INVALID_CAPACITY', invalidReason: 'pending_capacity' }));
        if (this.history.length > this.options.maxForecasts) this.history.shift();
      }
      const result = { asset, timestamp: now, currentPrice: current, horizons };
      this.emit('forecast', result);
      try { if (root.__poCore && typeof root.__poCore.onPredictiveForecast === 'function') root.__poCore.onPredictiveForecast(result); } catch (_) {}
      return result;
    }
    _settle(asset, timestamp, price) {
      const settledRecords = [], invalidRecords = [];
      for (const [id, forecast] of this.pending) {
        if (forecast.asset !== asset || timestamp < forecast.dueAt) continue;
        const delay = timestamp - forecast.dueAt;
        if (delay > this.options.maxSettlementDelayMs) {
          const invalid = Object.assign({}, forecast, { status: 'INVALID_LATE_TICK', settledAt: timestamp, delayMs: delay });
          this.history.push(invalid);
          if (this.history.length > this.options.maxForecasts) this.history.shift();
          this.pending.delete(id);
          invalidRecords.push(invalid);
          this.emit('invalid', invalid, false);
          continue;
        }
        const actualDirection = signDirection(price, forecast.entry, this.options.drawEpsilon * forecast.entry);
        const actualError = Math.abs(price - forecast.predicted) / forecast.entry;
        const modelResults = {};
        for (const model of Object.keys(forecast.models)) {
          const predictedDirection = forecast.modelDirections[model];
          const stat = this._stat(asset, forecast.horizon, model);
          stat.n++;
          stat.lastUpdatedAt = timestamp;
          const isDraw = actualDirection === 'DRAW';
          if (isDraw) stat.draws++;
          else {
            stat.decisive++;
            const correct = predictedDirection === actualDirection;
            if (correct) stat.wins++; else stat.losses++;
            const probabilityUp = forecast.modelProbabilities[model];
            const actualUp = actualDirection === 'UP' ? 1 : 0;
            stat.brier += (probabilityUp - actualUp) ** 2;
          }
          stat.mae += Math.abs(price - forecast.models[model]) / forecast.entry;
          modelResults[model] = {
            predictedPrice: forecast.models[model], predictedDirection,
            correct: actualDirection === 'DRAW' ? null : predictedDirection === actualDirection
          };
        }
        const record = Object.assign({}, forecast, {
          status: 'SETTLED', settledAt: timestamp, delayMs: delay,
          actualPrice: price, actualDirection, actualError, modelResults
        });
        this.history.push(record);
        if (this.history.length > this.options.maxForecasts) this.history.shift();
        this.pending.delete(id);
        settledRecords.push(record);
        this.emit('settled', record, false);
      }
      if (settledRecords.length || invalidRecords.length) {
        this.emit('settlement_batch', { asset, settled: settledRecords, invalid: invalidRecords });
      }
    }
    getStats(asset) {
      asset = this._key(asset);
      const rows = [];
      for (const horizon of HORIZONS) for (const model of MODEL_IDS) {
        const st = this.stats.get(this._statKey(asset, horizon, model)) || { n:0, decisive:0, wins:0, losses:0, draws:0, mae:0, brier:0 };
        rows.push({
          asset, horizonSeconds: horizon, model, samples: st.n, decisiveSamples: st.decisive,
          draws: st.draws, accuracy: st.decisive ? st.wins/st.decisive : null,
          meanAbsoluteError: st.n ? st.mae/st.n : null,
          brierScore: st.decisive ? st.brier/st.decisive : null,
          confidenceCalibrated: false, confidenceEvidenceBased: st.decisive >= this.options.minEvaluationSamples
        });
      }
      return rows;
    }
    getHistory(limit = 100) { return this.history.slice(-Math.max(0, limit)); }
    getPending() { return Array.from(this.pending.values()); }
    setOptions(next = {}) {
      const allowed = ['enabled','minSamples','confidenceFloor','forecastIntervalMs','minEvaluationSamples','maxSettlementDelayMs'];
      for (const key of allowed) if (Object.prototype.hasOwnProperty.call(next, key)) this.options[key] = next[key];
      this.options.minSamples = clamp(Number(this.options.minSamples)||80, 30, 2000);
      this.options.confidenceFloor = clamp(Number(this.options.confidenceFloor)||0.52, 0.5, 0.95);
      this.emit('config', Object.assign({}, this.options));
    }
  }

  root.PT4PredictiveEngine = PredictiveEngine;
  root.__pt4PredictiveEngine = root.__pt4PredictiveEngine || new PredictiveEngine();
  root.addEventListener('message', event => {
    const data = event.data;
    if (!data || event.source !== root) return;
    if (data.type === 'PT4_PREDICTIVE_CONFIG') {
      root.__pt4PredictiveEngine.setOptions(data.config || {});
      if (data.config && data.config.predictive) {
        root.__PT4_PREDICTIVE_CONFIG = Object.assign({}, data.config.predictive);
        if (root.__poCore && typeof root.__poCore.setPredictiveConfig === 'function') root.__poCore.setPredictiveConfig(root.__PT4_PREDICTIVE_CONFIG);
      }
    }
    if (data.type === 'PT4_PREDICTIVE_HELLO') root.postMessage({ type: 'PT4_PREDICTIVE_READY' }, '*');
    if (data.type === 'PT4_PREDICTIVE_RESTORE') root.__pt4PredictiveEngine.restoreState(data.state);
  });
  root.postMessage({ type: 'PT4_PREDICTIVE_READY' }, '*');
  // Reuse the existing inject.js Pocket Option WebSocket quote event.
  root.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.type !== 'POROBOT_WS_PRICE' || !data.asset || !/_otc$/i.test(data.asset)) return;
    const result = root.__pt4PredictiveEngine.ingest(data);
    if (result) root.postMessage({ type: 'POROBOT_PREDICTIVE_UPDATE', forecast: result }, '*');
  });
})(window);
