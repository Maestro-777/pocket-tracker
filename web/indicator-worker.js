"use strict";

function nanArray(length) {
  const values = new Float64Array(length);
  values.fill(Number.NaN);
  return values;
}

function rollingMean(source, period) {
  const out = nanArray(source.length);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < source.length; i++) {
    if (Number.isFinite(source[i])) { sum += source[i]; count++; }
    if (i >= period && Number.isFinite(source[i - period])) {
      sum -= source[i - period];
      count--;
    }
    if (i >= period - 1 && count === period) out[i] = sum / period;
  }
  return out;
}

function ema(source, period) {
  const out = nanArray(source.length);
  if (!source.length) return out;
  const alpha = 2 / (period + 1);
  let value = Number.NaN;
  let seed = 0;
  let seedCount = 0;
  for (let i = 0; i < source.length; i++) {
    if (!Number.isFinite(source[i])) continue;
    if (!Number.isFinite(value)) {
      seed += source[i];
      seedCount++;
      if (seedCount === period) value = seed / period;
    } else {
      value = source[i] * alpha + value * (1 - alpha);
    }
    if (Number.isFinite(value)) out[i] = value;
  }
  return out;
}

function rollingExtrema(source, period, highMode) {
  const out = nanArray(source.length);
  const deque = [];
  let head = 0;
  for (let i = 0; i < source.length; i++) {
    while (head < deque.length && deque[head] <= i - period) head++;
    while (deque.length > head) {
      const last = deque[deque.length - 1];
      if (highMode ? source[last] <= source[i] : source[last] >= source[i]) deque.pop();
      else break;
    }
    deque.push(i);
    if (i >= period - 1) out[i] = source[deque[head]];
    if (head > 1024 && head * 2 > deque.length) {
      deque.splice(0, head);
      head = 0;
    }
  }
  return out;
}

function rollingStd(source, period, means) {
  const out = nanArray(source.length);
  let sum = 0;
  let sumSquares = 0;
  for (let i = 0; i < source.length; i++) {
    sum += source[i];
    sumSquares += source[i] * source[i];
    if (i >= period) {
      sum -= source[i - period];
      sumSquares -= source[i - period] * source[i - period];
    }
    if (i >= period - 1) {
      const mean = sum / period;
      out[i] = Math.sqrt(Math.max(0, sumSquares / period - mean * mean));
    }
  }
  return out;
}

function trueRange(high, low, close) {
  const out = nanArray(close.length);
  for (let i = 0; i < close.length; i++) {
    out[i] = i === 0
      ? high[i] - low[i]
      : Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  }
  return out;
}

function wilder(source, period) {
  const out = nanArray(source.length);
  let value = Number.NaN;
  let seedSum = 0;
  let seedCount = 0;
  for (let i = 0; i < source.length; i++) {
    if (!Number.isFinite(source[i])) continue;
    if (!Number.isFinite(value)) {
      seedSum += source[i];
      seedCount++;
      if (seedCount === period) {
        value = seedSum / period;
        out[i] = value;
      }
    } else {
      value = ((value * (period - 1)) + source[i]) / period;
      out[i] = value;
    }
  }
  return out;
}

function middleOfRange(high, low, period) {
  const hh = rollingExtrema(high, period, true);
  const ll = rollingExtrema(low, period, false);
  const out = nanArray(high.length);
  for (let i = 0; i < out.length; i++) {
    if (Number.isFinite(hh[i]) && Number.isFinite(ll[i])) out[i] = (hh[i] + ll[i]) / 2;
  }
  return out;
}

function addOutput(outputs, name, values) {
  outputs.push({ name, values });
}

function calculateIndicator(item, data) {
  const { open, high, low, close, volume, times } = data;
  const n = close.length;
  const p = item.params || {};
  const source = (kind) => {
    if (kind === "open") return open;
    if (kind === "high") return high;
    if (kind === "low") return low;
    if (kind === "close" || !kind) return close;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (kind === "hl2") out[i] = (high[i] + low[i]) / 2;
      else if (kind === "hlc3") out[i] = (high[i] + low[i] + close[i]) / 3;
      else if (kind === "ohlc4") out[i] = (open[i] + high[i] + low[i] + close[i]) / 4;
      else out[i] = close[i];
    }
    return out;
  };
  const price = source(p.source);
  const period = Math.max(1, Math.min(500, Math.round(Number(p.period) || 14)));
  const mult = Math.max(0.1, Math.min(10, Number(p.multiplier) || 2));
  const outputs = [];
  const tr = () => trueRange(high, low, close);

  switch (item.id) {
    case "sma":
      addOutput(outputs, "SMA", rollingMean(price, period));
      break;
    case "ema":
      addOutput(outputs, "EMA", ema(price, period));
      break;
    case "wma": {
      const out = nanArray(n);
      const denom = period * (period + 1) / 2;
      let windowSum = 0, weightedSum = 0;
      for (let i = 0; i < n; i++) {
        if (i < period) {
          windowSum += price[i];
          weightedSum += price[i] * (i + 1);
          if (i === period - 1) out[i] = weightedSum / denom;
        } else {
          const oldValue = price[i - period];
          weightedSum = weightedSum - windowSum + price[i] * period;
          windowSum = windowSum - oldValue + price[i];
          out[i] = weightedSum / denom;
        }
      }
      addOutput(outputs, "WMA", out);
      break;
    }
    case "dema": {
      const first = ema(price, period);
      const second = ema(first, period);
      const out = nanArray(n);
      for (let i = 0; i < n; i++) if (Number.isFinite(first[i]) && Number.isFinite(second[i])) out[i] = 2 * first[i] - second[i];
      addOutput(outputs, "DEMA", out);
      break;
    }
    case "bollinger": {
      const mid = rollingMean(price, period);
      const dev = rollingStd(price, period, mid);
      const upper = nanArray(n), lower = nanArray(n);
      for (let i = 0; i < n; i++) if (Number.isFinite(mid[i]) && Number.isFinite(dev[i])) {
        upper[i] = mid[i] + mult * dev[i];
        lower[i] = mid[i] - mult * dev[i];
      }
      addOutput(outputs, "Upper", upper); addOutput(outputs, "Basis", mid); addOutput(outputs, "Lower", lower);
      break;
    }
    case "keltner": {
      const mid = ema(close, period);
      const atr = wilder(tr(), period);
      const upper = nanArray(n), lower = nanArray(n);
      for (let i = 0; i < n; i++) if (Number.isFinite(mid[i]) && Number.isFinite(atr[i])) {
        upper[i] = mid[i] + mult * atr[i]; lower[i] = mid[i] - mult * atr[i];
      }
      addOutput(outputs, "Upper", upper); addOutput(outputs, "Basis", mid); addOutput(outputs, "Lower", lower);
      break;
    }
    case "donchian": {
      const hh = rollingExtrema(high, period, true), ll = rollingExtrema(low, period, false);
      const mid = nanArray(n);
      for (let i = 0; i < n; i++) if (Number.isFinite(hh[i]) && Number.isFinite(ll[i])) mid[i] = (hh[i] + ll[i]) / 2;
      addOutput(outputs, "Upper", hh); addOutput(outputs, "Middle", mid); addOutput(outputs, "Lower", ll);
      break;
    }
    case "supertrend": {
      const atr = wilder(tr(), period);
      const line = nanArray(n);
      let upper = Number.NaN, lower = Number.NaN, direction = 1;
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(atr[i])) continue;
        const mid = (high[i] + low[i]) / 2;
        const basicUpper = mid + mult * atr[i], basicLower = mid - mult * atr[i];
        upper = !Number.isFinite(upper) || basicUpper < upper || close[i - 1] > upper ? basicUpper : upper;
        lower = !Number.isFinite(lower) || basicLower > lower || close[i - 1] < lower ? basicLower : lower;
        if (direction === 1 && close[i] < lower) direction = -1;
        else if (direction === -1 && close[i] > upper) direction = 1;
        line[i] = direction === 1 ? lower : upper;
      }
      addOutput(outputs, "SuperTrend", line);
      break;
    }
    case "ichimoku": {
      const tenkan = middleOfRange(high, low, Math.max(1, Number(p.tenkan) || 9));
      const kijun = middleOfRange(high, low, Math.max(1, Number(p.kijun) || 26));
      const spanB = middleOfRange(high, low, Math.max(1, Number(p.senkou) || 52));
      const spanA = nanArray(n);
      for (let i = 0; i < n; i++) if (Number.isFinite(tenkan[i]) && Number.isFinite(kijun[i])) spanA[i] = (tenkan[i] + kijun[i]) / 2;
      addOutput(outputs, "Tenkan", tenkan); addOutput(outputs, "Kijun", kijun);
      addOutput(outputs, "Span A", spanA); addOutput(outputs, "Span B", spanB);
      break;
    }
    case "psar": {
      const out = nanArray(n);
      if (n > 1) {
        const step = Math.max(0.001, Number(p.step) || 0.02);
        const maxStep = Math.max(step, Number(p.maxStep) || 0.2);
        let rising = close[1] >= close[0];
        let sar = rising ? low[0] : high[0];
        let extreme = rising ? high[0] : low[0];
        let acceleration = step;
        for (let i = 1; i < n; i++) {
          sar = sar + acceleration * (extreme - sar);
          if (rising) {
            sar = Math.min(sar, low[i - 1], i > 1 ? low[i - 2] : low[i - 1]);
            if (low[i] < sar) { rising = false; sar = extreme; extreme = low[i]; acceleration = step; }
            else if (high[i] > extreme) { extreme = high[i]; acceleration = Math.min(maxStep, acceleration + step); }
          } else {
            sar = Math.max(sar, high[i - 1], i > 1 ? high[i - 2] : high[i - 1]);
            if (high[i] > sar) { rising = true; sar = extreme; extreme = high[i]; acceleration = step; }
            else if (low[i] < extreme) { extreme = low[i]; acceleration = Math.min(maxStep, acceleration + step); }
          }
          out[i] = sar;
        }
      }
      addOutput(outputs, "Parabolic SAR", out);
      break;
    }
    case "rsi": {
      const gains = nanArray(n), losses = nanArray(n);
      if (n) { gains[0] = 0; losses[0] = 0; }
      for (let i = 1; i < n; i++) { const delta = price[i] - price[i - 1]; gains[i] = Math.max(delta, 0); losses[i] = Math.max(-delta, 0); }
      const avgGain = wilder(gains, period), avgLoss = wilder(losses, period), out = nanArray(n);
      for (let i = 0; i < n; i++) {
        if (Number.isFinite(avgGain[i]) && Number.isFinite(avgLoss[i])) out[i] = avgLoss[i] === 0 ? 100 : 100 - (100 / (1 + avgGain[i] / avgLoss[i]));
      }
      addOutput(outputs, "RSI", out);
      break;
    }
    case "macd": {
      const fast = ema(price, Number(p.fast) || 12), slow = ema(price, Number(p.slow) || 26);
      const line = nanArray(n);
      for (let i = 0; i < n; i++) if (Number.isFinite(fast[i]) && Number.isFinite(slow[i])) line[i] = fast[i] - slow[i];
      const signal = ema(line, Number(p.signal) || 9), hist = nanArray(n);
      for (let i = 0; i < n; i++) if (Number.isFinite(line[i]) && Number.isFinite(signal[i])) hist[i] = line[i] - signal[i];
      addOutput(outputs, "MACD", line); addOutput(outputs, "Signal", signal); addOutput(outputs, "Histogram", hist);
      break;
    }
    case "stochastic": {
      const kPeriod = Number(p.k) || 14, dPeriod = Number(p.d) || 3;
      const hh = rollingExtrema(high, kPeriod, true), ll = rollingExtrema(low, kPeriod, false);
      const rawK = nanArray(n);
      for (let i = 0; i < n; i++) if (Number.isFinite(hh[i]) && Number.isFinite(ll[i]) && hh[i] !== ll[i]) rawK[i] = 100 * (close[i] - ll[i]) / (hh[i] - ll[i]);
      const k = rollingMean(rawK, Math.max(1, Number(p.smoothK) || 1));
      addOutput(outputs, "%K", k); addOutput(outputs, "%D", rollingMean(k, dPeriod));
      break;
    }
    case "cci": {
      const typical = new Float64Array(n);
      for (let i = 0; i < n; i++) typical[i] = (high[i] + low[i] + close[i]) / 3;
      const avg = rollingMean(typical, period), out = nanArray(n);
      for (let i = period - 1; i < n; i++) {
        let dev = 0; for (let j = i - period + 1; j <= i; j++) dev += Math.abs(typical[j] - avg[i]);
        const meanDev = dev / period; if (meanDev) out[i] = (typical[i] - avg[i]) / (0.015 * meanDev);
      }
      addOutput(outputs, "CCI", out);
      break;
    }
    case "williams": {
      const hh = rollingExtrema(high, period, true), ll = rollingExtrema(low, period, false);
      const out = nanArray(n);
      for (let i = 0; i < n; i++) if (Number.isFinite(hh[i]) && Number.isFinite(ll[i]) && hh[i] !== ll[i]) out[i] = -100 * (hh[i] - close[i]) / (hh[i] - ll[i]);
      addOutput(outputs, "Williams %R", out);
      break;
    }
    case "roc": {
      const out = nanArray(n);
      for (let i = period; i < n; i++) if (price[i - period] !== 0) out[i] = 100 * (price[i] - price[i - period]) / price[i - period];
      addOutput(outputs, "ROC", out);
      break;
    }
    case "ao": {
      const median = new Float64Array(n);
      for (let i = 0; i < n; i++) median[i] = (high[i] + low[i]) / 2;
      const fast = rollingMean(median, Number(p.fast) || 5), slow = rollingMean(median, Number(p.slow) || 34), out = nanArray(n);
      for (let i = 0; i < n; i++) if (Number.isFinite(fast[i]) && Number.isFinite(slow[i])) out[i] = fast[i] - slow[i];
      addOutput(outputs, "Awesome Oscillator", out);
      break;
    }
    case "atr":
      addOutput(outputs, "ATR", wilder(tr(), period));
      break;
    case "adx": {
      const plusDM = nanArray(n), minusDM = nanArray(n), trueR = tr();
      plusDM[0] = 0; minusDM[0] = 0;
      for (let i = 1; i < n; i++) {
        const up = high[i] - high[i - 1], down = low[i - 1] - low[i];
        plusDM[i] = up > down && up > 0 ? up : 0;
        minusDM[i] = down > up && down > 0 ? down : 0;
      }
      const atr = wilder(trueR, period), pDM = wilder(plusDM, period), mDM = wilder(minusDM, period);
      const plusDI = nanArray(n), minusDI = nanArray(n), dx = nanArray(n);
      for (let i = 0; i < n; i++) if (atr[i] > 0) {
        plusDI[i] = 100 * pDM[i] / atr[i]; minusDI[i] = 100 * mDM[i] / atr[i];
        const total = plusDI[i] + minusDI[i]; if (total) dx[i] = 100 * Math.abs(plusDI[i] - minusDI[i]) / total;
      }
      addOutput(outputs, "+DI", plusDI); addOutput(outputs, "-DI", minusDI); addOutput(outputs, "ADX", wilder(dx, period));
      break;
    }
    case "obv": {
      const out = nanArray(n); let value = 0; out[0] = 0;
      for (let i = 1; i < n; i++) {
        if (!Number.isFinite(volume[i])) { out[i] = Number.NaN; continue; }
        if (close[i] > close[i - 1]) value += volume[i];
        else if (close[i] < close[i - 1]) value -= volume[i];
        out[i] = value;
      }
      addOutput(outputs, "OBV", out);
      break;
    }
    case "vwap": {
      const out = nanArray(n); let sumPV = 0, sumV = 0, day = -1;
      for (let i = 0; i < n; i++) {
        const currentDay = Math.floor(times[i] / 86400);
        if (currentDay !== day) { day = currentDay; sumPV = 0; sumV = 0; }
        if (!Number.isFinite(volume[i])) continue;
        const typical = (high[i] + low[i] + close[i]) / 3;
        sumPV += typical * volume[i]; sumV += volume[i];
        if (sumV > 0) out[i] = sumPV / sumV;
      }
      addOutput(outputs, "VWAP", out);
      break;
    }
    case "mfi": {
      const typical = new Float64Array(n), positive = nanArray(n), negative = nanArray(n);
      for (let i = 0; i < n; i++) typical[i] = (high[i] + low[i] + close[i]) / 3;
      for (let i = 1; i < n; i++) {
        if (!Number.isFinite(volume[i])) continue;
        const flow = typical[i] * volume[i];
        positive[i] = typical[i] > typical[i - 1] ? flow : 0;
        negative[i] = typical[i] < typical[i - 1] ? flow : 0;
      }
      const out = nanArray(n);
      let pos = 0, neg = 0;
      for (let i = 0; i < n; i++) {
        pos += Number.isFinite(positive[i]) ? positive[i] : 0;
        neg += Number.isFinite(negative[i]) ? negative[i] : 0;
        if (i >= period) {
          pos -= Number.isFinite(positive[i - period]) ? positive[i - period] : 0;
          neg -= Number.isFinite(negative[i - period]) ? negative[i - period] : 0;
        }
        if (i >= period) out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
      }
      addOutput(outputs, "MFI", out);
      break;
    }
    case "pivots": {
      const out = { pp:nanArray(n), r1:nanArray(n), s1:nanArray(n), r2:nanArray(n), s2:nanArray(n) };
      let day = -1, dayHigh = -Infinity, dayLow = Infinity, dayClose = Number.NaN;
      let prev = null;
      for (let i = 0; i < n; i++) {
        const currentDay = Math.floor(times[i] / 86400);
        if (currentDay !== day) {
          if (day !== -1 && Number.isFinite(dayClose)) prev = { high:dayHigh, low:dayLow, close:dayClose };
          day = currentDay; dayHigh = high[i]; dayLow = low[i]; dayClose = close[i];
        } else {
          dayHigh = Math.max(dayHigh, high[i]); dayLow = Math.min(dayLow, low[i]); dayClose = close[i];
        }
        if (prev) {
          const pp = (prev.high + prev.low + prev.close) / 3;
          out.pp[i] = pp; out.r1[i] = 2 * pp - prev.low; out.s1[i] = 2 * pp - prev.high;
          out.r2[i] = pp + (prev.high - prev.low); out.s2[i] = pp - (prev.high - prev.low);
        }
      }
      addOutput(outputs, "Pivot", out.pp); addOutput(outputs, "R1", out.r1); addOutput(outputs, "S1", out.s1);
      addOutput(outputs, "R2", out.r2); addOutput(outputs, "S2", out.s2);
      break;
    }
  }
  return { uid:item.uid, id:item.id, panel:item.panel, lines:outputs };
}

self.onmessage = (event) => {
  const message = event.data;
  if (!message || message.type !== "calculate") return;
  try {
    const data = {
      times: message.times, open: message.open, high: message.high,
      low: message.low, close: message.close, volume: message.volume
    };
    const results = message.indicators.map(item => calculateIndicator(item, data));
    const transfer = [];
    for (const result of results) for (const line of result.lines) transfer.push(line.values.buffer);
    self.postMessage({ type:"result", jobId:message.jobId, results }, transfer);
  } catch (error) {
    self.postMessage({ type:"error", jobId:message.jobId, error:String(error && error.message || error) });
  }
};
