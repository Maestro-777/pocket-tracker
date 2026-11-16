(() => {
  "use strict";
  const CHANNEL = "POCKET_TRACKER_BRIDGE_V3";
  const DEFAULTS = {
    asset: "AUTO", amount: 1, candleSeconds: 5, expirySeconds: 15,
    bbPeriod: 20, bbDeviation: 2, rsiPeriod: 14,
    putRsiMin: 77, putRsiMax: 83, callRsiMin: 18, callRsiMax: 23,
    maxDistancePoints: 1, lookbackDays: 30
  };
  const MAX_CANDLES = 530000;
  const state = {
    hookReady: false, connected: false, demoEndpointSeen: false, demoVerified: false,
    accountMode: "unknown", endpoint: "", socketCount: 0,
    asset: "EURUSD_otc", chartAsset: "", assets: [], quote: null, lastTickAt: 0,
    candles: [], current: null, candleCount: 0, historyRows: 0, rsi: null,
    bbUpper: null, bbLower: null, lastSignal: null, signalEnabled: false,
    autoTrading: false, amount: 1, orderPending: false, activeOrder: false,
    activeDealCount: 0, executionUncertain: false, lastOrder: null,
    journal: [], status: "Ожидание торговой вкладки Pocket Option.",
    config: Object.assign({}, DEFAULTS), subscribedAsset: "", lastSignalId: "", historyCycle: 0
  };
  let statusTimer = null;

  function emitCommand(command, args) {
    try { window.postMessage({ channel: CHANNEL, type: "COMMAND", command: command, args: args || {} }, location.origin); } catch (_) {}
  }
  function note(message) {
    state.status = String(message || "");
    try { chrome.runtime.sendMessage({ type: "PT_STATE_CHANGED" }); } catch (_) {}
  }
  function log(message) {
    state.journal.unshift({ time: new Date().toLocaleTimeString(), text: String(message) });
    if (state.journal.length > 40) state.journal.length = 40;
    note(message);
  }
  function normalizeSeconds(value) {
    let n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n > 1e12) n = n / 1000;
    else if (n > 1e10) n = n / 1000;
    return Math.floor(n);
  }
  function safeSymbol(value) {
    const symbol = String(value || "").trim();
    return /^[A-Za-z0-9_#]{3,32}$/.test(symbol) ? symbol : "";
  }
  function sameAsset(a, b) {
    return String(a || "").toUpperCase() === String(b || "").toUpperCase();
  }
  function activeAsset() {
    return state.config.asset === "AUTO" ? (state.chartAsset || state.asset || "EURUSD_otc") : state.config.asset;
  }
  function domAccountMode() {
    try {
      const real = [
        ".accounts-list__item--real.active", ".accounts-list__item--real.is-active",
        '[data-account-type="real"].active', ".switcher__btn--real.active",
        ".header-balance__item--real.active", ".balance-info--real.active"
      ];
      const demo = [
        ".accounts-list__item--demo.active", ".accounts-list__item--demo.is-active",
        '[data-account-type="demo"].active', ".switcher__btn--demo.active",
        ".header-balance__item--demo.active", ".balance-info--demo.active"
      ];
      for (const s of real) if (document.querySelector(s)) return "real";
      for (const s of demo) if (document.querySelector(s)) return "demo";
    } catch (_) {}
    return "unknown";
  }
  function publicState() {
    const mode = domAccountMode();
    if (mode === "real" || state.accountMode === "real") state.autoTrading = false;
    const demoVerified = state.demoVerified && state.accountMode !== "real" && mode !== "real";
    return {
      hookReady: state.hookReady, connected: state.connected,
      demoEndpointSeen: state.demoEndpointSeen, demoVerified: demoVerified,
      accountMode: mode === "real" ? "real" : (demoVerified ? "demo" : state.accountMode),
      endpoint: state.endpoint, socketCount: state.socketCount,
      asset: activeAsset(), chartAsset: state.chartAsset,
      assets: state.assets.slice(0, 300), quote: state.quote, lastTickAt: state.lastTickAt,
      candleCount: state.candleCount, historyRows: state.historyRows,
      rsi: state.rsi, bbUpper: state.bbUpper, bbLower: state.bbLower,
      lastSignal: state.lastSignal, signalEnabled: state.signalEnabled,
      autoTrading: state.autoTrading, amount: state.amount,
      orderPending: state.orderPending, activeOrder: state.activeOrder,
      activeDealCount: state.activeDealCount, executionUncertain: state.executionUncertain,
      lastOrder: state.lastOrder, status: mode === "real" ? "Обнаружен REAL-счёт. Все торговые команды заблокированы." : state.status,
      journal: state.journal.slice(0, 20), config: Object.assign({}, state.config)
    };
  }
  function closeEnough(a, b) { return Math.abs(Number(a) - Number(b)) <= 1e-9; }
  function updateConfig(patch) {
    const next = Object.assign({}, state.config, patch || {});
    const numeric = ["amount","bbPeriod","bbDeviation","rsiPeriod","putRsiMin","putRsiMax","callRsiMin","callRsiMax","maxDistancePoints","lookbackDays"];
    for (const key of numeric) {
      const n = Number(next[key]);
      if (!Number.isFinite(n)) throw new Error("Некорректное значение настройки: " + key);
      next[key] = n;
    }
    if (next.amount < 1 || next.amount > 50000) throw new Error("Сумма сделки должна быть от 1 до 50000.");
    if (next.bbPeriod < 2 || next.bbPeriod > 200) throw new Error("Период BB должен быть от 2 до 200.");
    if (next.bbDeviation <= 0 || next.bbDeviation > 5) throw new Error("Отклонение BB должно быть больше 0 и не более 5.");
    if (next.rsiPeriod < 2 || next.rsiPeriod > 100) throw new Error("Период RSI должен быть от 2 до 100.");
    if (next.maxDistancePoints < 0 || next.maxDistancePoints > 20) throw new Error("Допуск от полосы должен быть от 0 до 20 пунктов.");
    if (next.putRsiMin < 0 || next.putRsiMax > 100 || next.putRsiMin > next.putRsiMax ||
        next.callRsiMin < 0 || next.callRsiMax > 100 || next.callRsiMin > next.callRsiMax) {
      throw new Error("Неверные диапазоны RSI.");
    }
    const symbol = String(next.asset || "AUTO").trim();
    if (symbol !== "AUTO" && !safeSymbol(symbol)) throw new Error("Некорректный символ инструмента.");
    next.asset = symbol;
    state.config = next;
    state.amount = next.amount;
    chrome.storage.local.set({ pocketTrackerConfig: next }).catch(function(){});
    return next;
  }
  function resetMarketData() {
    state.candles = [];
    state.current = null;
    state.candleCount = 0;
    state.historyRows = 0;
    state.quote = null;
    state.lastTickAt = 0;
    state.rsi = null;
    state.bbUpper = null;
    state.bbLower = null;
    state.lastSignal = null;
    state.lastSignalId = "";
    state.subscribedAsset = "";
  }
  function subscribeCurrentAsset() {
    const asset = safeSymbol(activeAsset());
    if (!state.demoVerified || !asset) return;
    if (sameAsset(state.subscribedAsset, asset)) return;
    resetMarketData();
    state.asset = asset;
    state.subscribedAsset = asset;
    const cycle = ++state.historyCycle;
    emitCommand("SUBSCRIBE", { asset: asset, period: 5, lookbackDays: state.config.lookbackDays });
    note("Подписка запрошена: " + asset + " · 5 секунд. Запрашиваю историю до 30 дней.");
    setTimeout(function() {
      if (cycle !== state.historyCycle || !state.demoVerified ||
          !sameAsset(activeAsset(), asset) || state.candleCount > 0) return;
      log("Полная история пока не получена. Повторяю запрос с меньшей глубиной.");
      emitCommand("SUBSCRIBE", { asset: asset, period: 5, lookbackSeconds: 9000 });
    }, 9000);
  }
  function inferPointSize(asset) {
    const row = state.assets.find(function(x) { return x.symbol === asset; });
    if (row && Number.isInteger(row.digits) && row.digits >= 0 && row.digits <= 12) return Math.pow(10, -row.digits);
    if (/JPY/i.test(asset)) return 0.001;
    if (/BTC|ETH/i.test(asset)) return 0.01;
    return 0.00001;
  }
  function normalizeCandle(row) {
    if (!row) return null;
    let t, o, h, l, c;
    if (Array.isArray(row)) {
      if (row.length < 5) return null;
      t = normalizeSeconds(row[0]);
      const a = Number(row[1]), b = Number(row[2]), d = Number(row[3]), e = Number(row[4]);
      const first = { open: a, close: b, high: d, low: e };
      const second = { open: a, high: b, low: d, close: e };
      const valid = x => [x.open,x.high,x.low,x.close].every(Number.isFinite) &&
        x.high >= Math.max(x.open,x.close,x.low) && x.low <= Math.min(x.open,x.close,x.high);
      const chosen = valid(first) ? first : (valid(second) ? second : null);
      if (!chosen || !t) return null;
      o=chosen.open;h=chosen.high;l=chosen.low;c=chosen.close;
    } else if (typeof row === "object") {
      t = normalizeSeconds(row.time ?? row.timestamp ?? row.ts ?? row.t);
      o = Number(row.open ?? row.o);
      h = Number(row.high ?? row.h);
      l = Number(row.low ?? row.l);
      c = Number(row.close ?? row.c ?? row.price ?? row.p);
      if (!t || ![o,h,l,c].every(Number.isFinite) || h < Math.max(o,c,l) || l > Math.min(o,c,h)) return null;
    } else return null;
    const bucket = Math.floor(t / 5) * 5;
    return { time: bucket, open: o, high: h, low: l, close: c };
  }
  function mergeCandleArrays(oldRows, newRows) {
    if (!newRows.length) return oldRows;
    newRows.sort(function(a,b){return a.time-b.time;});
    if (!oldRows.length) return newRows.slice(-MAX_CANDLES);
    const oldLast = oldRows[oldRows.length - 1].time;
    if (newRows[0].time > oldLast) {
      oldRows.push.apply(oldRows, newRows);
      if (oldRows.length > MAX_CANDLES) oldRows.splice(0, oldRows.length - MAX_CANDLES);
      return oldRows;
    }
    const merged = [];
    let i=0, j=0;
    while (i<oldRows.length && j<newRows.length) {
      const a=oldRows[i], b=newRows[j];
      if (a.time < b.time) { merged.push(a); i++; }
      else if (b.time < a.time) { merged.push(b); j++; }
      else {
        merged.push({time:a.time,open:a.open,high:Math.max(a.high,b.high),
          low:Math.min(a.low,b.low),close:b.close});
        i++; j++;
      }
    }
    while(i<oldRows.length) merged.push(oldRows[i++]);
    while(j<newRows.length) merged.push(newRows[j++]);
    if (merged.length > MAX_CANDLES) merged.splice(0, merged.length - MAX_CANDLES);
    return merged;
  }
  function ingestHistory(message) {
    const asset = safeSymbol(message.asset || activeAsset());
    const period = Number(message.period || 5);
    if (!asset || !sameAsset(asset, activeAsset()) || period !== 5) return;
    const rows = Array.isArray(message.rows) ? message.rows : [];
    if (!rows.length) return;
    const batch = [];
    let tickRows = [];
    for (const row of rows) {
      const candle = normalizeCandle(row);
      if (candle) batch.push(candle);
      else if (Array.isArray(row) && row.length >= 2) {
        const t = normalizeSeconds(row[0]), price = Number(row[1]);
        if (t && Number.isFinite(price) && price > 0) tickRows.push({ time: t, price: price });
      } else if (row && typeof row === "object") {
        const t = normalizeSeconds(row.time ?? row.timestamp ?? row.ts ?? row.t);
        const price = Number(row.price ?? row.p ?? row.rate ?? row.value);
        if (t && Number.isFinite(price) && price > 0) tickRows.push({ time: t, price: price });
      }
    }
    if (tickRows.length) {
      const grouped = new Map();
      tickRows.sort(function(a,b){return a.time-b.time;});
      for (const tick of tickRows) {
        const bucket = Math.floor(tick.time / 5) * 5;
        const c = grouped.get(bucket);
        if (!c) grouped.set(bucket,{time:bucket,open:tick.price,high:tick.price,low:tick.price,close:tick.price});
        else { c.high=Math.max(c.high,tick.price);c.low=Math.min(c.low,tick.price);c.close=tick.price; }
      }
      batch.push.apply(batch,Array.from(grouped.values()));
    }
    if (!batch.length) return;
    if (state.current) {
      const currentBatch = batch.filter(function(c){return c.time === state.current.time;});
      for (const c of currentBatch) {
        state.current = { time:c.time, open:c.open, high:Math.max(state.current.high,c.high),
          low:Math.min(state.current.low,c.low), close:state.current.close };
      }
      const withoutCurrent = batch.filter(function(c){return c.time !== state.current.time;});
      state.candles = mergeCandleArrays(state.candles, withoutCurrent);
    } else {
      state.candles = mergeCandleArrays(state.candles, batch);
    }
    state.historyRows += rows.length;
    state.candleCount = state.candles.length;
    note("История загружена: " + state.candleCount + " свечей по 5 секунд.");
    updateIndicators();
  }
  function parseTicks(value, hint, out) {
    out = out || [];
    if (Array.isArray(value)) {
      if (value.length >= 3 && (typeof value[0] === "string" || typeof value[0] === "number")) {
        const asset = String(value[0]);
        const time = normalizeSeconds(value[1]);
        const price = Number(value[2]);
        if (time && Number.isFinite(price) && price > 0) out.push({ asset: asset, time: time, price: price });
        return out;
      }
      if (value.length === 2 && hint) {
        const time = normalizeSeconds(value[0]), price = Number(value[1]);
        if (time && Number.isFinite(price) && price > 0) out.push({ asset: hint, time: time, price: price });
        return out;
      }
      for (const item of value) parseTicks(item, hint, out);
      return out;
    }
    if (value && typeof value === "object") {
      const asset = value.asset || value.symbol || value.pair || hint;
      if (Array.isArray(value.prices)) {
        for (const tick of value.prices) {
          const time = normalizeSeconds(tick.time ?? tick.timestamp ?? tick.t);
          const price = Number(tick.price ?? tick.p);
          if (asset && time && Number.isFinite(price) && price > 0) out.push({ asset: String(asset),time:time,price:price });
        }
      } else {
        const time = normalizeSeconds(value.time ?? value.timestamp ?? value.t);
        const price = Number(value.price ?? value.rate ?? value.value ?? value.close);
        if (asset && time && Number.isFinite(price) && price > 0) out.push({ asset:String(asset),time:time,price:price });
        else {
          for (const key of Object.keys(value)) parseTicks(value[key], /^[A-Za-z0-9_#]{3,32}$/.test(key) ? key : hint, out);
        }
      }
    }
    return out;
  }
  function updateIndicators() {
    const rows = state.candles;
    const period = state.config.bbPeriod;
    const rsiPeriod = state.config.rsiPeriod;
    // Warm up Wilder smoothing with several RSI windows, not just one.
    const needed = Math.max(period, rsiPeriod * 5 + 1);
    if (rows.length < needed) {
      state.rsi = null; state.bbUpper = null; state.bbLower = null; return;
    }
    const closes = rows.slice(-needed).map(function(c){return c.close;});
    const windowRows = closes.slice(-period);
    const mean = windowRows.reduce(function(sum,v){return sum+v;},0)/period;
    const variance = windowRows.reduce(function(sum,v){return sum+(v-mean)*(v-mean);},0)/period;
    const deviation = Math.sqrt(variance);
    state.bbUpper = mean + state.config.bbDeviation * deviation;
    state.bbLower = mean - state.config.bbDeviation * deviation;
    const n = rsiPeriod;
    let gains = 0, losses = 0;
    for (let i=1;i<=n;i++) {
      const diff=closes[i]-closes[i-1];
      gains += Math.max(diff,0); losses += Math.max(-diff,0);
    }
    let avgGain=gains/n, avgLoss=losses/n;
    for(let i=n+1;i<closes.length;i++){
      const diff=closes[i]-closes[i-1];
      avgGain=(avgGain*(n-1)+Math.max(diff,0))/n;
      avgLoss=(avgLoss*(n-1)+Math.max(-diff,0))/n;
    }
    state.rsi = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100/(1+avgGain/avgLoss);
  }
  function checkSignal(closedCandle) {
    if (!state.signalEnabled) return;
    updateIndicators();
    if (state.rsi === null || state.bbUpper === null || state.bbLower === null) return;
    const asset = activeAsset();
    const point = inferPointSize(asset);
    const tolerance = point * state.config.maxDistancePoints;
    const rsi = state.rsi;
    let direction = null;
    if (closedCandle.close >= state.bbUpper &&
        closedCandle.close - state.bbUpper <= tolerance &&
        rsi >= state.config.putRsiMin && rsi <= state.config.putRsiMax) direction = "PUT";
    if (closedCandle.close <= state.bbLower &&
        state.bbLower - closedCandle.close <= tolerance &&
        rsi >= state.config.callRsiMin && rsi <= state.config.callRsiMax) direction = "CALL";
    if (!direction) return;
    const id = asset + ":5:" + closedCandle.time + ":" + direction;
    if (id === state.lastSignalId) return;
    state.lastSignalId = id;
    state.lastSignal = {
      id:id, asset:asset, direction:direction, time:closedCandle.time,
      price:closedCandle.close, rsi:rsi, upper:state.bbUpper, lower:state.bbLower,
      createdAt:Date.now()
    };
    log("Сигнал " + direction + " · " + asset + " · RSI " + rsi.toFixed(1));
    if (state.autoTrading && state.signalEnabled) {
      sendOrder(direction, "auto").catch(function(error) {
        state.autoTrading = false;
        log("Автоторговля остановлена: " + (error && error.message ? error.message : String(error)));
      });
    }
  }
  function onTick(tick) {
    const asset = safeSymbol(tick.asset);
    if (!asset || !sameAsset(asset, activeAsset())) return;
    if (domAccountMode() === "real") {
      if (state.autoTrading) log("REAL-счёт обнаружен в интерфейсе. Автоторговля остановлена.");
      state.autoTrading = false; state.demoVerified = false;
      return;
    }
    if (!state.demoVerified) return;
    const time = normalizeSeconds(tick.time), price = Number(tick.price);
    if (!time || !Number.isFinite(price) || price <= 0) return;
    const tickMs = time * 1000;
    const ageMs = Date.now() - tickMs;
    if (ageMs > 30000 || ageMs < -60000) return;
    const bucket = Math.floor(time / 5) * 5;
    state.quote = price;
    state.lastTickAt = tickMs;
    if (!state.current) {
      const existing = state.candles.find(function(c){return c.time===bucket;});
      if (existing) {
        state.current = Object.assign({}, existing);
        state.candles = state.candles.filter(function(c){return c.time!==bucket;});
      } else state.current = {time:bucket,open:price,high:price,low:price,close:price};
    } else if (bucket < state.current.time) {
      return;
    } else if (bucket > state.current.time) {
      const closed = state.current;
      state.candles = mergeCandleArrays(state.candles, [closed]);
      state.candleCount = state.candles.length;
      checkSignal(closed);
      state.current = {time:bucket,open:price,high:price,low:price,close:price};
    } else {
      state.current.high = Math.max(state.current.high,price);
      state.current.low = Math.min(state.current.low,price);
      state.current.close = price;
    }
    updateIndicators();
    if (Date.now() - (statusTimer || 0) > 800) {
      statusTimer = Date.now();
      try { chrome.runtime.sendMessage({ type:"PT_STATE_CHANGED" }); } catch (_) {}
    }
  }
  function updateSocketState(data) {
    state.socketCount = Number(data.socketCount || 0);
    state.connected = Boolean(data.socketConnected);
    state.demoEndpointSeen = Boolean(data.demoEndpointSeen);
    state.demoVerified = Boolean(data.demoVerified);
    state.accountMode = String(data.accountMode || "unknown");
    state.endpoint = String(data.endpoint || "");
    if (state.accountMode === "real" || !state.demoVerified) {
      state.autoTrading = false;
      if (state.accountMode === "real") log("REAL-счёт обнаружен. Торговля и автоторговля заблокированы.");
    } else {
      if (!state.subscribedAsset) subscribeCurrentAsset();
      if (state.status.indexOf("DEMO") < 0) note("Подключение DEMO подтверждено брокером.");
    }
  }
  function handlePageMessage(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL) return;
    if (data.type === "HOOK_READY") {
      state.hookReady = true; note(data.message || "Перехватчик готов.");
      emitCommand("REQUEST_STATUS", {});
    } else if (data.type === "SOCKET_STATUS") {
      updateSocketState(data);
    } else if (data.type === "BALANCE_STATE") {
      if (data.isDemo === false) {
        state.demoVerified = false; state.accountMode = "real"; state.autoTrading = false;
        log("Сервер сообщил isDemo=false. Все сделки заблокированы.");
      }
    } else if (data.type === "ASSET_LIST") {
      state.assets = Array.isArray(data.assets) ? data.assets : [];
    } else if (data.type === "CHART_ASSET") {
      const symbol = safeSymbol(data.asset);
      if (symbol) {
        const previousAsset = activeAsset();
        state.chartAsset = symbol;
        if (state.config.asset === "AUTO" && !sameAsset(previousAsset, symbol)) {
          state.asset = symbol;
          state.subscribedAsset = "";
          subscribeCurrentAsset();
        }
      }
    } else if (data.type === "HISTORY_CHUNK") {
      ingestHistory(data);
    } else if (data.type === "MARKET_TICKS") {
      const ticks = parseTicks(data.payload, activeAsset(), []);
      for (const tick of ticks) onTick(tick);
    } else if (data.type === "COMMAND_RESULT") {
      if (data.command === "SUBSCRIBE") {
        if (data.ok) note(data.message + " Инструмент: " + (data.asset || activeAsset()));
        else note(data.message || "Не удалось подписаться на рынок.");
      } else if (data.command === "OPEN_ORDER" && data.ok === false) {
        state.orderPending = false;
        state.executionUncertain = false;
        state.autoTrading = false;
        if (state.lastOrder) state.lastOrder.status = "Не отправлен: " + (data.message || "ошибка проверки");
        log(data.message || "Брокерское соединение не приняло команду открытия ордера.");
      }
    } else if (data.type === "ORDER_SENT") {
      state.orderPending = true;
      state.lastOrder = { requestId:data.requestId, asset:data.asset, direction:data.direction, amount:data.amount, expiry:data.expiry, status:"Ожидает подтверждения" };
      log("Ордер " + data.direction + " отправлен. Ожидаю подтверждение брокера.");
      setTimeout(function() {
        if (state.orderPending && state.lastOrder && state.lastOrder.requestId === data.requestId) {
          state.orderPending = false;
          state.executionUncertain = true;
          state.autoTrading = false;
          log("Нет подтверждения ордера. Повторная отправка заблокирована; запрашиваю открытые сделки.");
          emitCommand("REQUEST_STATUS", {});
        }
      }, 12000);
      setTimeout(function() {
        if (state.executionUncertain && state.lastOrder && state.lastOrder.requestId === data.requestId) {
          emitCommand("REQUEST_STATUS", {});
          log("Повторно проверяю статус неопределённого ордера у брокера.");
        }
      }, 32000);
    } else if (data.type === "ORDER_ACK") {
      const order = data.order || {};
      if (data.accepted) {
        if (state.lastOrder && order.requestId != null && String(order.requestId) === String(state.lastOrder.requestId)) {
          state.orderPending = false;
          state.activeOrder = true;
          state.lastOrder.id = order.id;
          state.lastOrder.status = "Открыта брокером";
          log("Брокер подтвердил открытие сделки.");
        }
      } else {
        if (state.lastOrder && order.requestId != null && String(order.requestId) === String(state.lastOrder.requestId)) {
          state.orderPending = false;
          state.executionUncertain = false;
          state.autoTrading = false;
          if (state.lastOrder) state.lastOrder.status = "Отклонена: " + (order.error || "ошибка");
          log("Брокер отклонил ордер: " + (order.error || "неизвестная ошибка"));
        }
      }
    } else if (data.type === "ORDER_STATUS_RESOLVED") {
      state.orderPending = false;
      state.executionUncertain = false;
      state.activeOrder = false;
      state.activeDealCount = 0;
      if (state.lastOrder) state.lastOrder.status = "Не найден среди открытых сделок";
      log("Брокер подтвердил: открытых сделок нет. Блокировка снята.");
    } else if (data.type === "OPEN_DEALS") {
      const deals = Array.isArray(data.deals) ? data.deals : [];
      const open = deals.filter(function(d){return d.closeTimestamp == null || d.closeTimestamp === 0 || d.closeTimestamp === "";});
      state.activeDealCount = open.length;
      state.activeOrder = open.length > 0;
      if (open.length > 0) {
        state.orderPending = false;
        state.executionUncertain = false;
        if (state.lastOrder) state.lastOrder.status = "Найдена среди открытых сделок";
      } else if (!state.orderPending && !state.executionUncertain) {
        state.activeOrder = false;
      }
    } else if (data.type === "CLOSED_DEALS") {
      const deals = Array.isArray(data.deals) ? data.deals : [];
      for (const d of deals) {
        const profit = Number(d.profit || 0);
        const result = profit > 0 ? "WIN" : (String(d.status).toLowerCase() === "draw" ? "DRAW" : "LOSS");
        log("Сделка закрыта: " + result + " · P/L " + profit.toFixed(2));
      }
      state.activeOrder = false; state.activeDealCount = 0; state.orderPending = false;
      state.executionUncertain = false;
      if (state.lastOrder) state.lastOrder.status = "Закрыта";
    } else if (data.type === "EXTERNAL_ORDER") {
      state.activeOrder = true;
      state.activeDealCount = Math.max(1,state.activeDealCount);
      log("Обнаружен ордер, открытый вручную в Pocket Option. Новый ордер заблокирован до закрытия.");
    } else if (data.type === "BROKER_AUTH_ERROR") {
      state.connected = false; state.demoVerified = false; state.autoTrading = false;
      log(data.message || "Ошибка сессии Pocket Option.");
    }
  }

  async function sendOrder(direction, source) {
    const mode = domAccountMode();
    if (mode === "real" || state.accountMode === "real") throw new Error("REAL-счёт обнаружен. Сделки запрещены.");
    if (!state.demoVerified || !state.connected) throw new Error("Сначала открой авторизованный DEMO-терминал Pocket Option.");
    if (!state.lastTickAt || Date.now() - state.lastTickAt > 10000) throw new Error("Нет свежей котировки. Сделка заблокирована.");
    if (state.executionUncertain) throw new Error("Предыдущий ордер не подтверждён. Повтор заблокирован.");
    if (state.orderPending) throw new Error("Предыдущий ордер ещё ожидает подтверждения.");
    if (state.activeOrder || state.activeDealCount > 0) throw new Error("Уже есть открытая сделка. Дождись закрытия.");
    const amount = Number(state.config.amount);
    if (!Number.isFinite(amount) || amount < 1 || amount > 50000) throw new Error("Некорректная сумма сделки.");
    const asset = safeSymbol(activeAsset());
    if (!asset) throw new Error("Не удалось определить торговый инструмент.");
    state.orderPending = true;
    state.lastOrder = { asset:asset, direction:direction, amount:amount, expiry:15, status:"Отправляется", source:source };
    emitCommand("OPEN_ORDER", { asset:asset, direction:direction, amount:amount, expiry:15 });
    try { chrome.runtime.sendMessage({ type:"PT_STATE_CHANGED" }); } catch (_) {}
  }
  async function handleCommand(message) {
    if (message.type === "PT_GET_STATE") return publicState();
    if (message.type === "PT_SET_CONFIG") {
      updateConfig(message.patch || {});
      if (message.patch && Object.prototype.hasOwnProperty.call(message.patch,"asset")) {
        resetMarketData(); subscribeCurrentAsset();
      }
      return { ok:true, state:publicState() };
    }
    if (message.type === "PT_SUBSCRIBE") {
      subscribeCurrentAsset();
      return { ok:true, message:"Запрошена подписка на " + activeAsset() };
    }
    if (message.type === "PT_SET_SIGNAL") {
      state.signalEnabled = Boolean(message.enabled);
      if (!state.signalEnabled) state.autoTrading = false;
      log(state.signalEnabled ? "Поиск сигналов включён." : "Поиск сигналов остановлен.");
      return { ok:true, state:publicState() };
    }
    if (message.type === "PT_SET_AUTO") {
      if (message.enabled && (!state.demoVerified || domAccountMode() === "real")) throw new Error("Автоторговля доступна только после подтверждения DEMO.");
      if (message.enabled && !state.signalEnabled) throw new Error("Сначала включи поиск сигналов.");
      state.autoTrading = Boolean(message.enabled);
      log(state.autoTrading ? "Автоторговля включена." : "Автоторговля выключена.");
      return { ok:true, state:publicState() };
    }
    if (message.type === "PT_MANUAL_TRADE") {
      await sendOrder(String(message.direction).toUpperCase(), "manual");
      return { ok:true, message:"Ордер передан DEMO-соединению." };
    }
    if (message.type === "PT_CLEAR_UNCERTAIN") {
      if (state.orderPending) throw new Error("Ордер ещё ожидает ответа.");
      emitCommand("REQUEST_STATUS", {});
      state.activeOrder = true;
      log("Запрошена повторная проверка у брокера. Блокировка останется до подтверждённого статуса.");
      return { ok:true, state:publicState() };
    }
    return { ok:false, message:"Неизвестная команда." };
  }
  chrome.runtime.onMessage.addListener(function(message, sender, respond) {
    if (!message || typeof message.type !== "string" || !message.type.startsWith("PT_")) return false;
    Promise.resolve().then(function(){return handleCommand(message);})
      .then(respond)
      .catch(function(error){respond({ok:false,message:error && error.message ? error.message : String(error)});});
    return true;
  });

  window.addEventListener("message", handlePageMessage, true);
  chrome.storage.local.get("pocketTrackerConfig").then(function(data) {
    if (data && data.pocketTrackerConfig) {
      try { updateConfig(data.pocketTrackerConfig); } catch (_) {}
    }
    state.amount = state.config.amount;
    emitCommand("REQUEST_STATUS", {});
  }).catch(function(){});
})();