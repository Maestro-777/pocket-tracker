(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const periodNames = {
    5:"5 секунд",15:"15 секунд",30:"30 секунд",60:"1 минута",
    300:"5 минут",900:"15 минут",1800:"30 минут",3600:"1 час"
  };
  const categoryNames = {
    trend:"Тренд", momentum:"Импульс", volatility:"Волатильность",
    volume:"Объём", price:"Price action"
  };
  const colorPalette = ["#f1c46a","#55adff","#d98af0","#22c997","#f08b96"];

  const indicatorCatalog = [
    {id:"sma",name:"Simple Moving Average",short:"SMA",category:"trend",panel:"overlay",description:"Простая скользящая средняя с выбором источника цены.",color:"#f1c46a",params:[{id:"period",label:"Период",default:20,min:1,max:500},{id:"source",label:"Источник цены",type:"select",default:"close",options:[["close","Close"],["open","Open"],["hl2","HL2"],["hlc3","HLC3"],["ohlc4","OHLC4"]]}]},
    {id:"ema",name:"Exponential Moving Average",short:"EMA",category:"trend",panel:"overlay",description:"Экспоненциальная средняя с выбором источника цены.",color:"#55adff",params:[{id:"period",label:"Период",default:50,min:1,max:500},{id:"source",label:"Источник цены",type:"select",default:"close",options:[["close","Close"],["open","Open"],["hl2","HL2"],["hlc3","HLC3"],["ohlc4","OHLC4"]]}]},
    {id:"wma",name:"Weighted Moving Average",short:"WMA",category:"trend",panel:"overlay",description:"Взвешенная скользящая средняя с выбором источника цены.",color:"#b69cf5",params:[{id:"period",label:"Период",default:20,min:1,max:500},{id:"source",label:"Источник цены",type:"select",default:"close",options:[["close","Close"],["open","Open"],["hl2","HL2"],["hlc3","HLC3"],["ohlc4","OHLC4"]]}]},
    {id:"dema",name:"Double Exponential Moving Average",short:"DEMA",category:"trend",panel:"overlay",description:"Двойная экспоненциальная средняя с выбором источника цены.",color:"#7bd0cb",params:[{id:"period",label:"Период",default:20,min:1,max:500},{id:"source",label:"Источник цены",type:"select",default:"close",options:[["close","Close"],["open","Open"],["hl2","HL2"],["hlc3","HLC3"],["ohlc4","OHLC4"]]}]},
    {id:"bollinger",name:"Bollinger Bands",short:"BB",category:"volatility",panel:"overlay",description:"SMA и полосы на основе стандартного отклонения.",color:"#e2b45c",params:[{id:"period",label:"Период",default:20,min:2,max:500},{id:"multiplier",label:"Отклонение",default:2,min:0.1,max:10,step:0.1},{id:"source",label:"Источник цены",type:"select",default:"close",options:[["close","Close"],["open","Open"],["hl2","HL2"],["hlc3","HLC3"],["ohlc4","OHLC4"]]}]},
    {id:"keltner",name:"Keltner Channels",short:"Keltner",category:"volatility",panel:"overlay",description:"Канал вокруг EMA с шириной на основе ATR.",color:"#65b9b0",params:[{id:"period",label:"Период",default:20,min:2,max:500},{id:"multiplier",label:"Множитель ATR",default:1.5,min:0.1,max:10,step:0.1}]},
    {id:"donchian",name:"Donchian Channels",short:"Donchian",category:"trend",panel:"overlay",description:"Максимум и минимум заданного окна свечей.",color:"#88a9e8",params:[{id:"period",label:"Период",default:20,min:2,max:500}]},
    {id:"supertrend",name:"SuperTrend",short:"SuperTrend",category:"trend",panel:"overlay",description:"Трендовая линия на основе ATR и коэффициента.",color:"#31c49a",params:[{id:"period",label:"ATR period",default:10,min:2,max:200},{id:"multiplier",label:"Множитель",default:3,min:0.1,max:10,step:0.1}]},
    {id:"ichimoku",name:"Ichimoku Cloud",short:"Ichimoku",category:"trend",panel:"overlay",description:"Tenkan, Kijun и линии облака Ichimoku.",color:"#8eabef",params:[{id:"tenkan",label:"Tenkan",default:9,min:2,max:200},{id:"kijun",label:"Kijun",default:26,min:2,max:200},{id:"senkou",label:"Senkou B",default:52,min:2,max:300}]},
    {id:"psar",name:"Parabolic SAR",short:"SAR",category:"trend",panel:"overlay",description:"Трендовый стоп с ускорением по экстремумам.",color:"#df9a62",params:[{id:"step",label:"Шаг",default:0.02,min:0.001,max:0.2,step:0.001},{id:"maxStep",label:"Максимальный шаг",default:0.2,min:0.01,max:1,step:0.01}]},
    {id:"pivots",name:"Pivot Points Classic",short:"Pivots",category:"price",panel:"overlay",description:"Классические дневные Pivot, R1/R2 и S1/S2.",color:"#dfc36e",params:[]},
    {id:"rsi",name:"Relative Strength Index",short:"RSI",category:"momentum",panel:"oscillator",description:"RSI Уайлдера с настраиваемыми уровнями и источником цены.",color:"#b48af3",params:[{id:"period",label:"Период",default:14,min:2,max:500},{id:"overbought",label:"Верхний уровень",default:70,min:50,max:100},{id:"oversold",label:"Нижний уровень",default:30,min:0,max:50},{id:"source",label:"Источник цены",type:"select",default:"close",options:[["close","Close"],["open","Open"],["hl2","HL2"],["hlc3","HLC3"]]}]},
    {id:"macd",name:"Moving Average Convergence Divergence",short:"MACD",category:"momentum",panel:"oscillator",description:"Линия MACD, сигнал и гистограмма с выбором типа средней.",color:"#62b6ef",params:[{id:"fast",label:"Быстрый период",default:12,min:2,max:200},{id:"slow",label:"Медленный период",default:26,min:3,max:300},{id:"signal",label:"Период сигнала",default:9,min:2,max:100},{id:"method",label:"Тип средней",type:"select",default:"ema",options:[["ema","EMA"],["sma","SMA"]]},{id:"source",label:"Источник цены",type:"select",default:"close",options:[["close","Close"],["open","Open"],["hl2","HL2"],["hlc3","HLC3"]]}]},
    {id:"stochastic",name:"Stochastic Oscillator",short:"Stochastic",category:"momentum",panel:"oscillator",description:"Стохастик с отдельными периодами %K, сглаживания и %D.",color:"#57c7b3",params:[{id:"k",label:"%K период",default:14,min:2,max:300},{id:"smoothK",label:"Сглаживание %K",default:3,min:1,max:100},{id:"d",label:"%D период",default:3,min:1,max:100},{id:"overbought",label:"Верхний уровень",default:80,min:50,max:100},{id:"oversold",label:"Нижний уровень",default:20,min:0,max:50}]},
    {id:"cci",name:"Commodity Channel Index",short:"CCI",category:"momentum",panel:"oscillator",description:"CCI с настраиваемым порогом.",color:"#e2a96b",params:[{id:"period",label:"Период",default:20,min:2,max:200},{id:"level",label:"Уровень зоны",default:100,min:25,max:300}]},
    {id:"williams",name:"Williams %R",short:"Williams %R",category:"momentum",panel:"oscillator",description:"Williams %R с настраиваемыми зонами.",color:"#7db6e9",params:[{id:"period",label:"Период",default:14,min:2,max:300},{id:"overbought",label:"Верхний уровень",default:-20,min:-50,max:0},{id:"oversold",label:"Нижний уровень",default:-80,min:-100,max:-50}]},
    {id:"roc",name:"Rate of Change",short:"ROC",category:"momentum",panel:"oscillator",description:"Процентное изменение цены за период.",color:"#e9a0ae",params:[{id:"period",label:"Период",default:12,min:1,max:500}]},
    {id:"ao",name:"Awesome Oscillator",short:"AO",category:"momentum",panel:"oscillator",description:"Разница короткой и длинной SMA медианной цены.",color:"#a4b7ee",params:[{id:"fast",label:"Быстрый период",default:5,min:2,max:100},{id:"slow",label:"Медленный период",default:34,min:3,max:200}]},
    {id:"atr",name:"Average True Range",short:"ATR",category:"volatility",panel:"oscillator",description:"Средний истинный диапазон волатильности.",color:"#ddaa6d",params:[{id:"period",label:"Период",default:14,min:2,max:500}]},
    {id:"adx",name:"Average Directional Index",short:"ADX / DMI",category:"trend",panel:"oscillator",description:"ADX, +DI и −DI с настраиваемым порогом силы тренда.",color:"#d28df0",params:[{id:"period",label:"Период",default:14,min:2,max:300},{id:"threshold",label:"Порог тренда",default:25,min:5,max:60}]},
    {id:"obv",name:"On Balance Volume",short:"OBV",category:"volume",panel:"oscillator",description:"Накопительный поток объёма по направлению свечи.",color:"#55c6a4",params:[],requiresVolume:true},
    {id:"vwap",name:"Volume Weighted Average Price",short:"VWAP",category:"volume",panel:"overlay",description:"Средняя цена, взвешенная по объёму внутри дня.",color:"#e3bb69",params:[],requiresVolume:true},
    {id:"mfi",name:"Money Flow Index",short:"MFI",category:"volume",panel:"oscillator",description:"MFI с настраиваемыми уровнями.",color:"#77b8ed",params:[{id:"period",label:"Период",default:14,min:2,max:300},{id:"overbought",label:"Верхний уровень",default:80,min:50,max:100},{id:"oversold",label:"Нижний уровень",default:20,min:0,max:50}],requiresVolume:true}
  ];

  const chartNode = $("chart");
  const emptyNode = $("chart-empty");
  const paneHost = $("indicator-panes");
  const statusDot = $("status-dot");
  const statusText = $("status-text");
  const connectionMessage = $("connection-message");
  const connectButton = $("connect-button");
  const disconnectButton = $("disconnect-button");
  const authInput = $("auth-frame");

  let socket = null;
  let retryTimer = null;
  let manuallyDisconnected = false;
  let activePeriod = 300;
  let activeAsset = "EURUSD_otc";
  let activeTool = "cursor";
  let trendStart = null;
  let priceLines = [];
  let drawingSeries = [];
  let candles = new Map();
  let sortedBarsCache = null;
  let liveCandle = null;
  let brokerConnected = false;
  let historyLoading = false;
  let hasMoreHistory = true;
  let initialHistoryLoaded = false;
  let autoLoadArmed = false;
  let followLive = true;

  let favoriteIds = loadStoredArray("pocket-tracker.indicator-favorites")
    .filter(id => indicatorCatalog.some(item => item.id === id));
  let activeIndicators = loadStoredArray("pocket-tracker.indicator-active")
    .filter(item => item && indicatorCatalog.some(def => def.id === item.id))
    .map(item => normalizeIndicatorInstance(item));
  let activeSettingsUid = null;
  let indicatorWorker = null;
  let indicatorWorkerBusy = false;
  let indicatorNeedsRefresh = false;
  let indicatorRefreshTimer = null;
  let latestIndicatorJobId = 0;
  let overlaySeries = [];
  let oscillatorPanes = [];
  let syncingRanges = false;

  const chart = LightweightCharts.createChart(chartNode, {
    width: chartNode.clientWidth || 900,
    height: chartNode.clientHeight || 420,
    layout: { background: { type:"solid", color:"#101824" }, textColor:"#8c9caf", fontFamily:"Inter, system-ui, sans-serif", fontSize:10 },
    grid: { vertLines:{color:"#1b2939"}, horzLines:{color:"#1b2939"} },
    crosshair: { mode:LightweightCharts.CrosshairMode.Normal, vertLine:{color:"#5b7898",width:1,style:2,labelBackgroundColor:"#294969"}, horzLine:{color:"#5b7898",width:1,style:2,labelBackgroundColor:"#294969"} },
    rightPriceScale: { borderColor:"#263548", scaleMargins:{top:0.12,bottom:0.12} },
    timeScale: { borderColor:"#263548", timeVisible:true, secondsVisible:activePeriod<=30, rightOffset:5, barSpacing:8, minBarSpacing:1 },
    localization: { timeFormatter:(time)=>{
      const stamp = typeof time==="number" ? time : Date.UTC(time.year,time.month-1,time.day)/1000;
      return new Date(stamp*1000).toLocaleString(undefined,{month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit",second:activePeriod<=30?"2-digit":undefined});
    }},
    handleScroll: { mouseWheel:true, pressedMouseMove:true, horzTouchDrag:true, vertTouchDrag:false },
    handleScale: { axisPressedMouseMove:true, mouseWheel:true, pinch:true }
  });

  const candleSeries = chart.addCandlestickSeries({
    upColor:"#20bd91", downColor:"#ed6674", borderUpColor:"#20bd91",
    borderDownColor:"#ed6674", wickUpColor:"#20bd91", wickDownColor:"#ed6674",
    priceLineVisible:true, lastValueVisible:true
  });

  const chartResizeObserver = new ResizeObserver(() => {
    chart.applyOptions({ width:chartNode.clientWidth, height:chartNode.clientHeight });
    for (const pane of oscillatorPanes) {
      pane.chart.applyOptions({ width:pane.container.clientWidth, height:pane.container.clientHeight });
    }
  });
  chartResizeObserver.observe(chartNode);

  try {
    indicatorWorker = new Worker("./indicator-worker.js");
    indicatorWorker.onmessage = handleIndicatorWorkerMessage;
    indicatorWorker.onerror = (event) => {
      console.error("Indicator worker failed", event.message);
      indicatorWorkerBusy = false;
      setStatus("Ошибка расчёта индикатора: " + (event.message || "worker"), "warning");
    };
  } catch (error) {
    console.error("Cannot create indicator worker", error);
  }

  function loadStoredArray(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(value) ? value : [];
    } catch (_) {
      return [];
    }
  }

  function persistIndicatorState() {
    try {
      localStorage.setItem("pocket-tracker.indicator-favorites", JSON.stringify(favoriteIds));
      localStorage.setItem("pocket-tracker.indicator-active", JSON.stringify(activeIndicators));
    } catch (error) {
      console.warn("Cannot save indicator settings", error);
    }
  }

  function normalizeIndicatorInstance(item) {
    const definition = indicatorCatalog.find(def => def.id === item.id);
    const params = {};
    for (const field of definition.params) {
      const rawValue = item.params && item.params[field.id];
      if (field.type === "select") {
        const allowed = (field.options || []).map(option => option[0]);
        params[field.id] = allowed.includes(rawValue) ? rawValue : field.default;
      } else {
        const raw = Number(rawValue);
        params[field.id] = Number.isFinite(raw)
          ? Math.min(field.max, Math.max(field.min, raw))
          : field.default;
      }
    }
    return {
      uid: item.uid || ("ind-" + Math.random().toString(36).slice(2)),
      id: item.id,
      params,
      color: /^#[0-9a-f]{6}$/i.test(item.color || "") ? item.color : definition.color,
      width: Math.min(4, Math.max(1, Number(item.width) || 2)),
      visible: item.visible !== false
    };
  }

  function definitionFor(id) {
    return indicatorCatalog.find(item => item.id === id);
  }

  function setStatus(message, state="info") {
    statusText.textContent = message;
    connectionMessage.textContent = message;
    connectionMessage.className = "connection-message" + (state==="error" ? " error" : state==="connected" ? " success" : "");
    statusDot.className = "status-indicator" + (state==="connected" ? " connected" : state==="error" ? " error" : "");
    if (state === "connected") {
      brokerConnected = true;
      disconnectButton.disabled = false;
    } else if (state === "ready" || state === "error") {
      brokerConnected = false;
      disconnectButton.disabled = true;
    }
  }

  function setBridgeState(ready) {
    $("bridge-warning").style.display = ready ? "none" : "flex";
    if (!ready && !brokerConnected) {
      setStatus("Локальный мост недоступен", "error");
      connectionMessage.textContent = "Запусти bridge.py из папки проекта и обнови страницу.";
    } else if (ready && !brokerConnected) {
      setStatus("Мост готов · ожидает сессию", "ready");
      connectionMessage.textContent = "Мост запущен. Вставь полный кадр авторизации и нажми «Подключить».";
    }
  }

  function openBridge() {
    if (manuallyDisconnected) return;
    try { socket = new WebSocket("ws://127.0.0.1:8765"); }
    catch (error) { scheduleRetry(); return; }
    socket.addEventListener("open", () => setBridgeState(true));
    socket.addEventListener("message", event => {
      try { handleBridgeMessage(JSON.parse(event.data)); }
      catch (error) { console.warn("Некорректный ответ локального моста", error); }
    });
    socket.addEventListener("close", () => { setBridgeState(false); scheduleRetry(); });
    socket.addEventListener("error", () => { setBridgeState(false); try { socket.close(); } catch (_) {} });
  }

  function scheduleRetry() {
    if (manuallyDisconnected || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!socket || socket.readyState === WebSocket.CLOSED) openBridge();
    }, 2500);
  }

  function sendBridge(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setStatus("Нет связи с локальным мостом", "error");
      return false;
    }
    socket.send(JSON.stringify(payload));
    return true;
  }

  function handleBridgeMessage(message) {
    if (message.type === "status") {
      setStatus(message.message || "Статус обновлён", message.state || "info");
      return;
    }
    if (message.type === "historyLoading") {
      setHistoryLoading(Boolean(message.loading), message.request_kind);
      return;
    }
    if (message.type === "historyProgress") {
      const count = Number(message.candles_count) || 0;
      const days = Number(message.days_covered) || 0;
      $("load-history-button").textContent = "Загружено " + count.toLocaleString("ru-RU") + " · " + days.toFixed(1) + " дн.";
      setStatus("Загружаю историю: " + count.toLocaleString("ru-RU") + " свечей · " + days.toFixed(1) + " дней", "connected");
      return;
    }
    if (message.type === "history") {
      if (message.asset !== activeAsset || Number(message.period) !== activePeriod) return;
      const cutoff = Math.floor(Date.now() / 1000) - 3 * 86400;
      const received = Array.isArray(message.candles) ? message.candles : [];
      candles = new Map(received.filter(bar => Number(bar.time) >= cutoff).map(bar => [Number(bar.time), normalizeBar(bar)]));
      sortedBarsCache = null;
      if (liveCandle) {
        candles.set(liveCandle.time, candles.has(liveCandle.time)
          ? mergeBars(candles.get(liveCandle.time), liveCandle)
          : normalizeBar(liveCandle));
      }
      initialHistoryLoaded = true;
      hasMoreHistory = message.has_more !== false;
      paintCandles(true);
      $("candle-count").textContent = candles.size.toLocaleString("ru-RU");
      $("data-state").textContent = "HISTORY";
      $("data-state").classList.remove("live");
      emptyNode.classList.add("hidden");
      followLive = true;
      setHistoryLoading(historyLoading, "bulk");
      return;
    }
    if (message.type === "historyComplete") {
      if (message.asset !== activeAsset || Number(message.period) !== activePeriod) return;
      if (Array.isArray(message.candles)) appendOlderHistory(message.candles);
      hasMoreHistory = message.has_more !== false;
      setHistoryLoading(false);
      if (!hasMoreHistory) endHistory();
      else $("load-history-button").textContent = "Загрузить ещё";
      return;
    }
    if (message.type === "historyOlder") {
      if (message.asset !== activeAsset || Number(message.period) !== activePeriod) return;
      appendOlderHistory(Array.isArray(message.candles) ? message.candles : []);
      hasMoreHistory = message.has_more !== false;
      setHistoryLoading(false);
      if (!hasMoreHistory) endHistory();
      return;
    }
    if (message.type === "historyEnd") {
      hasMoreHistory = false;
      setHistoryLoading(false);
      endHistory();
      return;
    }
    if (message.type === "candle") {
      if (message.asset !== activeAsset) return;
      const bar = normalizeBar(message.candle);
      if (!bar || !Number.isFinite(bar.time) || !Number.isFinite(bar.close)) return;
      liveCandle = bar;
      const previous = candles.get(bar.time);
      const merged = previous ? mergeBars(previous, bar) : bar;
      candles.set(bar.time, merged);
      if (sortedBarsCache) {
        const lastIndex = sortedBarsCache.length - 1;
        const last = sortedBarsCache[lastIndex];
        if (!last || bar.time > last.time) sortedBarsCache.push(merged);
        else if (bar.time === last.time) sortedBarsCache[lastIndex] = merged;
        else sortedBarsCache = null;
      }
      const rows = sortedBarsCache || sortedBars();
      const lastRow = rows[rows.length - 1];
      if (!lastRow || bar.time >= lastRow.time) {
        candleSeries.update(toChartCandle(merged));
      } else {
        candleSeries.setData(rows.map(toChartCandle));
      }
      if (followLive) chart.timeScale().scrollToRealTime();
      scheduleIndicatorCalculation();
      $("candle-count").textContent = candles.size.toLocaleString("ru-RU");
      $("data-state").textContent = "LIVE";
      $("data-state").classList.add("live");
      emptyNode.classList.add("hidden");
      if (message.price != null) updatePrice(Number(message.price));
      $("update-state").textContent = new Date().toLocaleTimeString();
      return;
    }
    if (message.type === "assets" && Array.isArray(message.symbols)) {
      const select = $("asset-select");
      const known = new Set(Array.from(select.options).map(option => option.value));
      for (const symbol of message.symbols) {
        if (known.has(symbol)) continue;
        const option = document.createElement("option");
        option.value = symbol;
        option.textContent = symbol.replace("_otc", " OTC");
        select.appendChild(option);
        known.add(symbol);
      }
    }
  }

  function setHistoryLoading(loading, requestKind) {
    historyLoading = loading;
    const button = $("load-history-button");
    button.disabled = loading || !initialHistoryLoaded || !hasMoreHistory;
    if (loading) {
      button.textContent = requestKind === "older" ? "Загрузка ещё…" : "Загружаю 7 дней…";
    } else if (hasMoreHistory && initialHistoryLoaded) {
      button.textContent = "Загрузить ещё";
    } else if (!hasMoreHistory && initialHistoryLoaded) {
      button.textContent = "История закончилась";
    } else {
      button.textContent = "Ожидание истории…";
    }
  }

  function endHistory() {
    hasMoreHistory = false;
    const button = $("load-history-button");
    button.disabled = true;
    button.textContent = "История закончилась";
  }

  function appendOlderHistory(rows) {
    const visibleRange = chart.timeScale().getVisibleLogicalRange();
    const previousSize = candles.size;
    const cutoff = Math.floor(Date.now() / 1000) - 3 * 86400;
    for (const row of rows) {
      const bar = normalizeBar(row);
      if (!Number.isFinite(bar.time) || !Number.isFinite(bar.close) || bar.time < cutoff) continue;
      if (!candles.has(bar.time)) candles.set(bar.time, bar);
    }
    if (liveCandle) {
      const current = candles.get(liveCandle.time);
      candles.set(liveCandle.time, current ? mergeBars(current, liveCandle) : normalizeBar(liveCandle));
    }
    const added = candles.size - previousSize;
    if (added > 0) sortedBarsCache = null;
    paintCandles(false);
    $("candle-count").textContent = candles.size.toLocaleString("ru-RU");
    if (visibleRange && added > 0) {
      chart.timeScale().setVisibleLogicalRange({
        from: visibleRange.from + added,
        to: visibleRange.to + added
      });
    }
    if (rows.length === 0 || added === 0) {
      if (historyLoading) return;
      endHistory();
    }
  }

  function requestMoreHistory() {
    if (historyLoading || !initialHistoryLoaded || !hasMoreHistory) return;
    if (sendBridge({ action:"loadMore" })) setHistoryLoading(true, "older");
  }

  function normalizeBar(bar) {
    const volume = bar.volume == null ? Number.NaN : Number(bar.volume);
    return {
      time:Math.floor(Number(bar.time)), open:Number(bar.open), high:Number(bar.high),
      low:Number(bar.low), close:Number(bar.close), volume
    };
  }

  function toChartCandle(bar) {
    return { time:bar.time, open:bar.open, high:bar.high, low:bar.low, close:bar.close };
  }

  function mergeBars(oldBar, newBar) {
    return {
      time:newBar.time, open:oldBar.open,
      high:Math.max(oldBar.high,newBar.high), low:Math.min(oldBar.low,newBar.low),
      close:newBar.close,
      volume:Number.isFinite(newBar.volume) ? newBar.volume : oldBar.volume
    };
  }

  function sortedBars() {
    if (!sortedBarsCache) {
      sortedBarsCache = Array.from(candles.values())
        .filter(bar => Number.isFinite(bar.time) && Number.isFinite(bar.close))
        .sort((a,b) => a.time - b.time);
    }
    return sortedBarsCache;
  }

  function paintCandles(fit) {
    const rows = sortedBars();
    candleSeries.setData(rows.map(toChartCandle));
    scheduleIndicatorCalculation();
    if (fit) {
      chart.timeScale().fitContent();
      followLive = true;
    }
    if (rows.length) {
      emptyNode.classList.add("hidden");
      $("data-state").textContent = "LIVE";
      $("data-state").classList.add("live");
    }
  }

  function updatePrice(price) {
    if (!Number.isFinite(price)) return;
    const digits = activeAsset.includes("JPY") ? 3 : activeAsset.includes("BTC") ? 2 : 5;
    $("last-price").textContent = price.toFixed(digits);
    $("price-time").textContent = new Date().toLocaleTimeString();
  }

  function setPeriod(period) {
    period = Number(period);
    if (!periodNames[period] || period === activePeriod) return;
    activePeriod = period;
    $("period-state").textContent = periodNames[activePeriod] || activePeriod + "s";
    document.querySelectorAll(".tf-button").forEach(button => {
      button.classList.toggle("active", Number(button.dataset.period) === activePeriod);
    });
    chart.applyOptions({ timeScale:{ secondsVisible:activePeriod<=30 } });
    resetMarketData();
    if (brokerConnected) sendBridge({ action:"subscribe", asset:activeAsset, period:activePeriod });
  }

  function setAsset(asset) {
    activeAsset = asset;
    const option = $("asset-select").selectedOptions[0];
    $("chart-title").innerHTML = escapeHtml(option ? option.textContent : asset) + ' <span class="otc-pill">OTC</span>';
    $("symbol-state").textContent = asset;
    resetMarketData();
    if (brokerConnected) sendBridge({ action:"subscribe", asset:activeAsset, period:activePeriod });
  }

  function resetMarketData() {
    candles.clear();
    sortedBarsCache = null;
    liveCandle = null;
    candleSeries.setData([]);
    initialHistoryLoaded = false;
    historyLoading = false;
    hasMoreHistory = true;
    autoLoadArmed = false;
    followLive = true;
    $("last-price").textContent = "—";
    $("price-time").textContent = "ожидание потока";
    $("candle-count").textContent = "0";
    $("update-state").textContent = "—";
    $("data-state").textContent = "ОЖИДАНИЕ";
    $("data-state").classList.remove("live");
    emptyNode.classList.remove("hidden");
    setHistoryLoading(false);
    scheduleIndicatorCalculation();
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    }[char]));
  }

  /* ---------- Indicator library, favourites and settings ---------- */

  function renderCatalog() {
    const host = $("indicator-catalog");
    const query = $("indicator-search").value.trim().toLowerCase();
    const category = $("indicator-category").value;
    const tab = document.querySelector(".modal-tab.active").dataset.indicatorTab;
    const rows = indicatorCatalog.filter(item => {
      const matchesQuery = !query || (item.name + " " + item.short + " " + item.description).toLowerCase().includes(query);
      const matchesCategory = category === "all" || item.category === category;
      const matchesTab = tab !== "favorites" || favoriteIds.includes(item.id);
      return matchesQuery && matchesCategory && matchesTab;
    });
    host.innerHTML = "";
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "no-indicators";
      empty.textContent = tab === "favorites" ? "В избранном пока ничего нет." : "По этому запросу индикаторы не найдены.";
      host.appendChild(empty);
      return;
    }
    for (const item of rows) {
      const card = document.createElement("article");
      card.className = "indicator-card";
      const top = document.createElement("div");
      top.className = "indicator-card-top";
      const title = document.createElement("div");
      title.className = "indicator-card-title";
      title.textContent = item.name;
      top.appendChild(title);
      const desc = document.createElement("div");
      desc.className = "indicator-card-description";
      desc.textContent = item.description;
      const meta = document.createElement("div");
      meta.className = "indicator-card-meta";
      const pill = document.createElement("span");
      pill.className = "indicator-category-pill";
      pill.textContent = categoryNames[item.category];
      const type = document.createElement("span");
      type.className = "indicator-category-pill";
      type.textContent = item.panel === "overlay" ? "На графике" : "Отдельная панель";
      meta.append(pill,type);
      const actions = document.createElement("div");
      actions.className = "indicator-card-actions";
      const add = document.createElement("button");
      add.className = "add-indicator";
      add.textContent = "＋ Добавить";
      add.addEventListener("click", () => addIndicator(item.id));
      const fav = document.createElement("button");
      fav.className = "favorite-indicator" + (favoriteIds.includes(item.id) ? " active" : "");
      fav.title = favoriteIds.includes(item.id) ? "Убрать из избранного" : "В избранное";
      fav.textContent = favoriteIds.includes(item.id) ? "★" : "☆";
      fav.addEventListener("click", () => toggleFavorite(item.id));
      actions.append(add,fav);
      card.append(top,desc,meta,actions);
      host.appendChild(card);
    }
  }

  function toggleFavorite(id) {
    if (favoriteIds.includes(id)) favoriteIds = favoriteIds.filter(value => value !== id);
    else favoriteIds.push(id);
    persistIndicatorState();
    renderCatalog();
  }

  function addIndicator(id) {
    const definition = definitionFor(id);
    if (!definition) return;
    const params = {};
    for (const field of definition.params) params[field.id] = field.default;
    activeIndicators.push(normalizeIndicatorInstance({
      uid:"ind-" + Date.now().toString(36) + Math.random().toString(36).slice(2,7),
      id, params, color:definition.color, width:2, visible:true
    }));
    persistIndicatorState();
    renderActiveIndicators();
    scheduleIndicatorCalculation();
  }

  function removeIndicator(uid) {
    activeIndicators = activeIndicators.filter(item => item.uid !== uid);
    persistIndicatorState();
    renderActiveIndicators();
    scheduleIndicatorCalculation();
  }

  function renderActiveIndicators() {
    const host = $("active-indicators-list");
    host.innerHTML = "";
    if (!activeIndicators.length) {
      const empty = document.createElement("div");
      empty.className = "empty-indicators";
      empty.textContent = "Пока нет активных индикаторов. Нажми «Добавить индикатор», чтобы открыть библиотеку.";
      host.appendChild(empty);
      return;
    }
    for (const instance of activeIndicators) {
      const definition = definitionFor(instance.id);
      const row = document.createElement("div");
      row.className = "active-indicator-row";
      const dot = document.createElement("span");
      dot.className = "active-indicator-color";
      dot.style.background = instance.color;
      const name = document.createElement("span");
      name.className = "active-indicator-name";
      name.textContent = definition.short + (definition.params.length
        ? " · " + definition.params.map(param => instance.params[param.id]).join("/")
        : "");
      if (!instance.visible) name.style.opacity = ".5";
      const visible = document.createElement("button");
      visible.className = "active-indicator-control";
      visible.title = instance.visible ? "Скрыть" : "Показать";
      visible.textContent = instance.visible ? "◉" : "○";
      visible.addEventListener("click", () => {
        instance.visible = !instance.visible;
        persistIndicatorState();
        renderActiveIndicators();
        scheduleIndicatorCalculation();
      });
      const settings = document.createElement("button");
      settings.className = "active-indicator-control";
      settings.title = "Параметры";
      settings.textContent = "⚙";
      settings.addEventListener("click", () => openIndicatorSettings(instance.uid));
      const remove = document.createElement("button");
      remove.className = "active-indicator-control remove";
      remove.title = "Удалить";
      remove.textContent = "×";
      remove.addEventListener("click", () => removeIndicator(instance.uid));
      row.append(dot,name,visible,settings,remove);
      host.appendChild(row);
    }
  }

  function openIndicatorSettings(uid) {
    const instance = activeIndicators.find(item => item.uid === uid);
    if (!instance) return;
    activeSettingsUid = uid;
    const definition = definitionFor(instance.id);
    $("indicator-settings-title").textContent = definition.name;
    const host = $("indicator-settings-fields");
    host.innerHTML = "";
    for (const field of definition.params) {
      const label = document.createElement("label");
      label.className = "setting-field";
      label.textContent = field.label;
      let input;
      if (field.type === "select") {
        input = document.createElement("select");
        for (const [value,text] of field.options || []) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = text;
          input.appendChild(option);
        }
        input.value = instance.params[field.id];
      } else {
        input = document.createElement("input");
        input.type = "number";
        input.min = field.min;
        input.max = field.max;
        input.step = field.step || 1;
        input.value = instance.params[field.id];
      }
      input.name = field.id;
      label.appendChild(input);
      host.appendChild(label);
    }
    const colorLabel = document.createElement("label");
    colorLabel.className = "setting-field";
    colorLabel.textContent = "Цвет линий";
    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.name = "color";
    colorInput.value = instance.color;
    colorLabel.appendChild(colorInput);
    host.appendChild(colorLabel);

    const widthLabel = document.createElement("label");
    widthLabel.className = "setting-field";
    widthLabel.textContent = "Толщина линии";
    const widthInput = document.createElement("input");
    widthInput.type = "number";
    widthInput.name = "width";
    widthInput.min = 1;
    widthInput.max = 4;
    widthInput.step = 1;
    widthInput.value = instance.width;
    widthLabel.appendChild(widthInput);
    host.appendChild(widthLabel);

    const visibility = document.createElement("label");
    visibility.className = "setting-check-row full";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.name = "visible";
    check.checked = instance.visible;
    visibility.append(check,document.createTextNode("Показывать на графике"));
    host.appendChild(visibility);
    $("indicator-settings-modal").hidden = false;
  }

  function saveIndicatorSettings() {
    const instance = activeIndicators.find(item => item.uid === activeSettingsUid);
    if (!instance) return;
    const definition = definitionFor(instance.id);
    const host = $("indicator-settings-fields");
    for (const field of definition.params) {
      const input = host.querySelector('[name="' + field.id + '"]');
      if (field.type === "select") {
        instance.params[field.id] = input.value;
        continue;
      }
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < field.min || value > field.max) {
        input.focus();
        input.setCustomValidity("Значение должно быть от " + field.min + " до " + field.max);
        input.reportValidity();
        return;
      }
      input.setCustomValidity("");
      instance.params[field.id] = value;
    }
    instance.color = host.querySelector('[name="color"]').value;
    instance.width = Math.min(4,Math.max(1,Number(host.querySelector('[name="width"]').value)||2));
    instance.visible = host.querySelector('[name="visible"]').checked;
    persistIndicatorState();
    renderActiveIndicators();
    $("indicator-settings-modal").hidden = true;
    scheduleIndicatorCalculation();
  }

  function openIndicatorLibrary() {
    $("indicator-search").value = "";
    $("indicator-category").value = "all";
    document.querySelectorAll(".modal-tab").forEach(tab => tab.classList.toggle("active",tab.dataset.indicatorTab==="all"));
    renderCatalog();
    $("indicator-modal").hidden = false;
  }

  function handleIndicatorWorkerMessage(event) {
    const message = event.data;
    indicatorWorkerBusy = false;
    if (message.type === "result" && message.jobId === latestIndicatorJobId) {
      renderIndicatorResults(message.results || []);
    } else if (message.type === "error") {
      console.error("Indicator calculation error:",message.error);
      setStatus("Ошибка расчёта индикаторов: " + message.error,"warning");
    }
    if (indicatorNeedsRefresh) {
      indicatorNeedsRefresh = false;
      scheduleIndicatorCalculation();
    }
  }

  function scheduleIndicatorCalculation() {
    if (indicatorRefreshTimer) clearTimeout(indicatorRefreshTimer);
    indicatorRefreshTimer = setTimeout(() => {
      indicatorRefreshTimer = null;
      runIndicatorCalculation();
    }, 1400);
  }

  function runIndicatorCalculation() {
    if (!indicatorWorker) {
      return;
    }
    if (indicatorWorkerBusy) {
      indicatorNeedsRefresh = true;
      return;
    }
    const active = activeIndicators.filter(item => item.visible);
    if (!active.length) {
      clearRenderedIndicators();
      return;
    }
    const rows = sortedBars();
    if (!rows.length) {
      clearRenderedIndicators();
      return;
    }
    const times = new Float64Array(rows.length);
    const open = new Float64Array(rows.length);
    const high = new Float64Array(rows.length);
    const low = new Float64Array(rows.length);
    const close = new Float64Array(rows.length);
    const volume = new Float64Array(rows.length);
    volume.fill(Number.NaN);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      times[i] = row.time;
      open[i] = row.open;
      high[i] = row.high;
      low[i] = row.low;
      close[i] = row.close;
      if (Number.isFinite(row.volume)) volume[i] = row.volume;
    }
    indicatorWorkerBusy = true;
    latestIndicatorJobId += 1;
    indicatorWorker.postMessage({
      type:"calculate", jobId:latestIndicatorJobId, times, open, high, low, close, volume,
      indicators:active.map(item => ({
        uid:item.uid,id:item.id,params:item.params,panel:definitionFor(item.id).panel
      }))
    },[times.buffer,open.buffer,high.buffer,low.buffer,close.buffer,volume.buffer]);
  }

  function clearRenderedIndicators() {
    for (const series of overlaySeries) chart.removeSeries(series);
    overlaySeries = [];
    for (const pane of oscillatorPanes) pane.chart.remove();
    oscillatorPanes = [];
    paneHost.innerHTML = "";
    paneHost.classList.remove("has-panes");
  }

  function renderIndicatorResults(results) {
    clearRenderedIndicators();
    const rows = sortedBars();
    const timeVisible = chart.timeScale().getVisibleLogicalRange();
    for (const result of results) {
      const instance = activeIndicators.find(item => item.uid === result.uid && item.visible);
      if (!instance) continue;
      const definition = definitionFor(instance.id);
      const dataLines = (result.lines || []).map((line,lineIndex) => {
        const data = [];
        const values = line.values;
        for (let i = 0; i < rows.length && i < values.length; i++) {
          if (Number.isFinite(values[i])) data.push({time:rows[i].time,value:values[i]});
        }
        return {name:line.name,data,color:lineIndex===0?instance.color:colorPalette[(lineIndex+1)%colorPalette.length]};
      }).filter(line => line.data.length);
      if (!dataLines.length) continue;
      if (definition.requiresVolume && !rows.some(row => Number.isFinite(row.volume))) {
        setStatus(definition.short + ": брокер не передаёт объём для этого инструмента.","warning");
        continue;
      }
      if (result.panel === "oscillator") {
        createOscillatorPane(definition,instance,dataLines,timeVisible);
      } else {
        dataLines.forEach(line => {
          const series = chart.addLineSeries({
            color:line.color,lineWidth:instance.width,priceLineVisible:false,
            lastValueVisible:false,crosshairMarkerVisible:false
          });
          series.setData(line.data);
          overlaySeries.push(series);
        });
      }
    }
  }

  function createOscillatorPane(definition,instance,lines,visibleRange) {
    const container = document.createElement("div");
    container.className = "indicator-pane";
    const heading = document.createElement("div");
    heading.className = "indicator-pane-heading";
    heading.textContent = definition.short + " · " + definition.params
      .filter(field => field.id !== "source")
      .map(field => instance.params[field.id]).join("/");
    const target = document.createElement("div");
    target.className = "indicator-pane-chart";
    container.append(heading,target);
    paneHost.appendChild(container);
    paneHost.classList.add("has-panes");

    const paneChart = LightweightCharts.createChart(target,{
      width:target.clientWidth||700,height:target.clientHeight||126,
      layout:{background:{type:"solid",color:"#0f1824"},textColor:"#7f90a5",fontFamily:"Inter, system-ui, sans-serif",fontSize:9},
      grid:{vertLines:{color:"#1a2838"},horzLines:{color:"#1a2838"}},
      rightPriceScale:{borderColor:"#263548",scaleMargins:{top:0.12,bottom:0.12}},
      timeScale:{borderColor:"#263548",timeVisible:true,secondsVisible:activePeriod<=30,visible:true,rightOffset:5,barSpacing:8,minBarSpacing:1},
      crosshair:{mode:LightweightCharts.CrosshairMode.Normal},
      handleScroll:{mouseWheel:true,pressedMouseMove:true,horzTouchDrag:true},
      handleScale:{axisPressedMouseMove:true,mouseWheel:true,pinch:true}
    });
    for (const line of lines) {
      const series = paneChart.addLineSeries({
        color:line.color,lineWidth:instance.width,priceLineVisible:false,
        lastValueVisible:false,crosshairMarkerVisible:false
      });
      series.setData(line.data);
      const p = instance.params || {};
      let levels = [];
      if (["rsi","mfi","stochastic","williams"].includes(definition.id)) {
        levels = [Number(p.oversold),Number(p.overbought)];
      } else if (definition.id==="cci") {
        levels = [-Number(p.level || 100),Number(p.level || 100)];
      } else if (definition.id==="adx") {
        levels = [Number(p.threshold || 25)];
      }
      for (const level of levels) {
        if (Number.isFinite(level)) series.createPriceLine({
          price:level,color:"#53687d",lineWidth:1,
          lineStyle:LightweightCharts.LineStyle.Dashed,
          axisLabelVisible:false,title:""
        });
      }
    }
    paneChart.timeScale().subscribeVisibleLogicalRangeChange(range=>syncTimeRanges(paneChart,range));
    if (visibleRange) {
      try { paneChart.timeScale().setVisibleLogicalRange(visibleRange); } catch (_) {}
    }
    oscillatorPanes.push({chart:paneChart,container});
    new ResizeObserver(()=>paneChart.applyOptions({width:target.clientWidth,height:target.clientHeight})).observe(target);
  }

  function syncTimeRanges(source,range) {
    if (!range || syncingRanges) return;
    syncingRanges = true;
    try {
      if (source !== chart) chart.timeScale().setVisibleLogicalRange(range);
      for (const pane of oscillatorPanes) {
        if (pane.chart !== source) pane.chart.timeScale().setVisibleLogicalRange(range);
      }
    } catch (_) {
      // Time ranges can briefly be unavailable while a pane is being rebuilt.
    } finally {
      syncingRanges = false;
    }
  }

  function setTool(tool) {
    activeTool = tool;
    trendStart = null;
    document.querySelectorAll(".tool-button[data-tool]").forEach(button => {
      button.classList.toggle("active",button.dataset.tool===tool);
    });
    const hints = {
      cursor:"Курсор · перетаскивай график и используй колёсико для масштаба",
      hline:"Уровень · нажми на график, чтобы поставить горизонтальную линию",
      trend:"Линия тренда · выбери первую точку"
    };
    $("tool-hint").textContent = hints[tool];
    chart.applyOptions({handleScroll:{pressedMouseMove:tool==="cursor"}});
  }

  function toUnix(time) {
    if (typeof time==="number") return time;
    if (time && typeof time==="object" && "year" in time) {
      return Math.floor(Date.UTC(time.year,time.month-1,time.day)/1000);
    }
    return null;
  }

  chart.subscribeClick(param=>{
    if (activeTool==="cursor" || !param.point) return;
    const price = candleSeries.coordinateToPrice(param.point.y);
    const time = toUnix(chart.timeScale().coordinateToTime(param.point.x));
    if (price==null || time==null || !Number.isFinite(price)) return;
    if (activeTool==="hline") {
      const line = candleSeries.createPriceLine({
        price,color:"#e5b75e",lineWidth:1,lineStyle:LightweightCharts.LineStyle.Dashed,
        axisLabelVisible:true,title:"Уровень"
      });
      priceLines.push(line);
    } else if (activeTool==="trend") {
      if (!trendStart) {
        trendStart = {time,price};
        $("tool-hint").textContent = "Линия тренда · выбери вторую точку";
      } else {
        const points = [{time:trendStart.time,value:trendStart.price},{time,value:price}].sort((a,b)=>a.time-b.time);
        if (points[0].time!==points[1].time) {
          const line = chart.addLineSeries({color:"#7fb8f4",lineWidth:2,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:true});
          line.setData(points);
          drawingSeries.push(line);
        }
        trendStart = null;
        $("tool-hint").textContent = "Линия тренда добавлена · выбери следующую пару точек";
      }
    }
  });

  chart.timeScale().subscribeVisibleLogicalRangeChange(range=>{
    syncTimeRanges(chart,range);
    if (range && initialHistoryLoaded) {
      const rows = sortedBars();
      followLive = range.to >= rows.length - 3;
    }
    if (!autoLoadArmed || !range || !initialHistoryLoaded || historyLoading || !hasMoreHistory) return;
    if (range.from<=2) {
      autoLoadArmed = false;
      requestMoreHistory();
    }
  });

  chartNode.addEventListener("wheel",()=>{autoLoadArmed=true;},{passive:true});
  chartNode.addEventListener("pointerdown",()=>{autoLoadArmed=true;});

  $("timeframes").addEventListener("click",event=>{
    const button = event.target.closest(".tf-button");
    if (button) setPeriod(button.dataset.period);
  });
  $("asset-select").addEventListener("change",event=>setAsset(event.target.value));
  $("load-history-button").addEventListener("click",requestMoreHistory);

  document.querySelectorAll(".tool-button[data-tool]").forEach(button=>button.addEventListener("click",()=>setTool(button.dataset.tool)));
  $("clear-drawings").addEventListener("click",()=>{
    for (const line of priceLines) candleSeries.removePriceLine(line);
    for (const series of drawingSeries) chart.removeSeries(series);
    priceLines = [];
    drawingSeries = [];
    trendStart = null;
    $("tool-hint").textContent = "Все пользовательские рисунки удалены";
  });
  function shiftVisibleBars(direction) {
    if (direction < 0) { autoLoadArmed = true; followLive = false; }
    const scale = chart.timeScale();
    const range = scale.getVisibleLogicalRange();
    if (!range) return;
    const width = Math.max(5, range.to - range.from);
    const shift = direction * Math.max(1, Math.round(width * 0.35));
    scale.setVisibleLogicalRange({from:range.from + shift,to:range.to + shift});
  }

  function zoomVisible(factor) {
    const scale = chart.timeScale();
    const range = scale.getVisibleLogicalRange();
    if (!range) return;
    const center = (range.from + range.to) / 2;
    const width = Math.max(10, Math.min(2000, (range.to - range.from) * factor));
    scale.setVisibleLogicalRange({from:center - width / 2,to:center + width / 2});
  }

  $("fit-button").addEventListener("click",()=>chart.timeScale().fitContent());
  $("nav-left").addEventListener("click",()=>shiftVisibleBars(-1));
  $("nav-right").addEventListener("click",()=>shiftVisibleBars(1));
  $("nav-zoom-in").addEventListener("click",()=>zoomVisible(0.75));
  $("nav-zoom-out").addEventListener("click",()=>zoomVisible(1.33));
  $("nav-latest").addEventListener("click",()=>{followLive=true;chart.timeScale().scrollToRealTime();});

  $("open-indicators").addEventListener("click",openIndicatorLibrary);
  $("close-indicators").addEventListener("click",()=>$("indicator-modal").hidden=true);
  $("indicator-modal").addEventListener("click",event=>{if(event.target.id==="indicator-modal")$("indicator-modal").hidden=true;});
  $("close-indicator-settings").addEventListener("click",()=>$("indicator-settings-modal").hidden=true);
  $("cancel-indicator-settings").addEventListener("click",()=>$("indicator-settings-modal").hidden=true);
  $("indicator-settings-modal").addEventListener("click",event=>{if(event.target.id==="indicator-settings-modal")$("indicator-settings-modal").hidden=true;});
  $("save-indicator-settings").addEventListener("click",saveIndicatorSettings);
  $("indicator-search").addEventListener("input",renderCatalog);
  $("indicator-category").addEventListener("change",renderCatalog);
  document.querySelectorAll(".modal-tab").forEach(tab=>tab.addEventListener("click",()=>{
    document.querySelectorAll(".modal-tab").forEach(item=>item.classList.toggle("active",item===tab));
    renderCatalog();
  }));
  document.addEventListener("keydown",event=>{
    if (event.key==="Escape") {
      $("indicator-modal").hidden = true;
      $("indicator-settings-modal").hidden = true;
    }
  });

  connectButton.addEventListener("click",()=>{
    const authFrame = authInput.value.trim();
    if (!authFrame) {
      setStatus("Вставь полный кадр авторизации Pocket Option.","error");
      authInput.focus();
      return;
    }
    if (!sendBridge({action:"connect",authFrame})) return;
    authInput.value = "";
    connectButton.disabled = true;
    setTimeout(()=>{connectButton.disabled=false;},3000);
  });

  disconnectButton.addEventListener("click",()=>{
    sendBridge({action:"disconnect"});
    brokerConnected = false;
    disconnectButton.disabled = true;
    resetMarketData();
  });

  window.addEventListener("beforeunload",()=>{
    if (socket && socket.readyState===WebSocket.OPEN) {
      socket.send(JSON.stringify({action:"disconnect"}));
      socket.close();
    }
  });

  chart.timeScale().applyOptions({secondsVisible:activePeriod<=30});
  $("symbol-state").textContent = activeAsset;
  $("period-state").textContent = periodNames[activePeriod];
  setHistoryLoading(false);
  renderActiveIndicators();
  openBridge();
})();