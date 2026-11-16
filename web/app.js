(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const periodNames = {15:"15 секунд",30:"30 секунд",60:"1 минута",300:"5 минут",900:"15 минут",1800:"30 минут",3600:"1 час"};
  const chartNode = $("chart"), emptyNode = $("chart-empty");
  const statusDot = $("status-dot"), statusText = $("status-text");
  const connectionMessage = $("connection-message"), connectButton = $("connect-button");
  const disconnectButton = $("disconnect-button"), authInput = $("auth-frame");
  let socket = null, retryTimer = null, manuallyDisconnected = false;
  let activePeriod = 300, activeAsset = "EURUSD_otc", activeTool = "cursor";
  let trendStart = null, priceLines = [], drawingSeries = [], candles = new Map();
  let liveCandle = null, brokerConnected = false;
  let historyLoading = false, hasMoreHistory = true, initialHistoryLoaded = false;
  let autoLoadArmed = false;

  const chart = LightweightCharts.createChart(chartNode, {
    width: chartNode.clientWidth || 900, height: chartNode.clientHeight || 520,
    layout: {background:{type:"solid",color:"#101824"},textColor:"#8c9caf",fontFamily:"Inter, system-ui, sans-serif",fontSize:10},
    grid: {vertLines:{color:"#1b2939"},horzLines:{color:"#1b2939"}},
    crosshair: {mode:LightweightCharts.CrosshairMode.Normal,vertLine:{color:"#5b7898",width:1,style:2,labelBackgroundColor:"#294969"},horzLine:{color:"#5b7898",width:1,style:2,labelBackgroundColor:"#294969"}},
    rightPriceScale: {borderColor:"#263548",scaleMargins:{top:0.12,bottom:0.12}},
    timeScale: {borderColor:"#263548",timeVisible:true,secondsVisible:false,rightOffset:5,barSpacing:8,minBarSpacing:2},
    localization: {timeFormatter:(time)=>{
      const stamp = typeof time === "number" ? time : Date.UTC(time.year,time.month-1,time.day)/1000;
      return new Date(stamp*1000).toLocaleString(undefined,{month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit"});
    }},
    handleScroll:{mouseWheel:true,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:false},
    handleScale:{axisPressedMouseMove:true,mouseWheel:true,pinch:true}
  });
  const candleSeries = chart.addCandlestickSeries({
    upColor:"#20bd91",downColor:"#ed6674",borderUpColor:"#20bd91",borderDownColor:"#ed6674",
    wickUpColor:"#20bd91",wickDownColor:"#ed6674",priceLineVisible:true,lastValueVisible:true
  });
  const smaSeries = chart.addLineSeries({color:"#f1c46a",lineWidth:2,priceLineVisible:false,lastValueVisible:false,visible:false,crosshairMarkerVisible:false});
  const emaSeries = chart.addLineSeries({color:"#55adff",lineWidth:2,priceLineVisible:false,lastValueVisible:false,visible:false,crosshairMarkerVisible:false});
  new ResizeObserver(()=>chart.applyOptions({width:chartNode.clientWidth,height:chartNode.clientHeight})).observe(chartNode);

  function setStatus(message,state="info") {
    statusText.textContent = message; connectionMessage.textContent = message;
    connectionMessage.className = "connection-message"+(state==="error"?" error":state==="connected"?" success":"");
    statusDot.className = "status-indicator"+(state==="connected"?" connected":state==="error"?" error":"");
    if(state==="connected"){brokerConnected=true;disconnectButton.disabled=false;}
    else if(state==="ready"||state==="error"){brokerConnected=false;disconnectButton.disabled=true;}
  }
  function setBridgeState(ready) {
    $("bridge-warning").style.display=ready?"none":"flex";
    if(!ready&&!brokerConnected){setStatus("Локальный мост недоступен","error");connectionMessage.textContent="Запусти bridge.py из папки проекта и обнови страницу.";}
    else if(ready&&!brokerConnected){setStatus("Мост готов · ожидает сессию","ready");connectionMessage.textContent="Мост запущен. Вставь полный кадр авторизации и нажми «Подключить».";}
  }
  function openBridge() {
    if(manuallyDisconnected)return;
    try{socket=new WebSocket("ws://127.0.0.1:8765");}
    catch(error){scheduleRetry();return;}
    socket.addEventListener("open",()=>setBridgeState(true));
    socket.addEventListener("message",(event)=>{try{handleBridgeMessage(JSON.parse(event.data));}catch(error){console.warn("Некорректный ответ локального моста",error);}});
    socket.addEventListener("close",()=>{setBridgeState(false);scheduleRetry();});
    socket.addEventListener("error",()=>{setBridgeState(false);try{socket.close();}catch(_){}});
  }
  function scheduleRetry() {
    if(manuallyDisconnected||retryTimer)return;
    retryTimer=setTimeout(()=>{retryTimer=null;if(!socket||socket.readyState===WebSocket.CLOSED)openBridge();},2500);
  }
  function sendBridge(payload) {
    if(!socket||socket.readyState!==WebSocket.OPEN){setStatus("Нет связи с локальным мостом","error");return false;}
    socket.send(JSON.stringify(payload));return true;
  }
  function handleBridgeMessage(message) {
    if(message.type==="status"){setStatus(message.message||"Статус обновлён",message.state||"info");return;}
    if(message.type==="historyLoading"){
      setHistoryLoading(Boolean(message.loading));
      return;
    }
    if(message.type==="history"){
      if(message.asset!==activeAsset||Number(message.period)!==activePeriod)return;
      const received=Array.isArray(message.candles)?message.candles:[];
      candles=new Map(received.map(bar=>[Number(bar.time),normalizeBar(bar)]));
      if(liveCandle){candles.set(liveCandle.time,candles.has(liveCandle.time)?mergeBars(candles.get(liveCandle.time),liveCandle):normalizeBar(liveCandle));}
      initialHistoryLoaded=true;
      hasMoreHistory=message.has_more!==false;
      setHistoryLoading(false);
      paintCandles(true);$("candle-count").textContent=String(candles.size);
      $("data-state").textContent="LIVE";$("data-state").classList.add("live");emptyNode.classList.add("hidden");return;
    }
    if(message.type==="historyOlder"){
      if(message.asset!==activeAsset||Number(message.period)!==activePeriod)return;
      appendOlderHistory(Array.isArray(message.candles)?message.candles:[]);
      hasMoreHistory=message.has_more!==false;
      setHistoryLoading(false);
      if(!hasMoreHistory)endHistory();
      return;
    }
    if(message.type==="historyEnd"){
      hasMoreHistory=false;
      setHistoryLoading(false);
      endHistory();
      return;
    }
    if(message.type==="candle"){
      if(message.asset!==activeAsset)return;
      const bar=normalizeBar(message.candle);if(!bar||!Number.isFinite(bar.time))return;
      liveCandle=bar;candles.set(bar.time,candles.has(bar.time)?mergeBars(candles.get(bar.time),bar):bar);
      candleSeries.update(bar);updateIndicators();$("candle-count").textContent=String(candles.size);
      $("data-state").textContent="LIVE";$("data-state").classList.add("live");emptyNode.classList.add("hidden");
      if(message.price!=null)updatePrice(Number(message.price));
      $("update-state").textContent=new Date().toLocaleTimeString();return;
    }
    if(message.type==="assets"&&Array.isArray(message.symbols)){
      const select=$("asset-select"),known=new Set(Array.from(select.options).map(option=>option.value));
      for(const symbol of message.symbols){if(known.has(symbol))continue;const option=document.createElement("option");option.value=symbol;option.textContent=symbol.replace("_otc"," OTC");select.appendChild(option);known.add(symbol);}
    }
  }
  function setHistoryLoading(loading){
    historyLoading=loading;
    const button=$("load-history-button");
    button.disabled=loading||!initialHistoryLoaded||!hasMoreHistory;
    button.textContent=loading?"Загрузка…":hasMoreHistory?"Загрузить ещё":"История закончилась";
  }
  function endHistory(){
    hasMoreHistory=false;
    const button=$("load-history-button");
    button.disabled=true;
    button.textContent="История закончилась";
  }
  function appendOlderHistory(rows){
    const visibleRange=chart.timeScale().getVisibleLogicalRange();
    const previousSize=candles.size;
    for(const row of rows){
      const bar=normalizeBar(row);
      if(!Number.isFinite(bar.time))continue;
      if(!candles.has(bar.time))candles.set(bar.time,bar);
    }
    if(liveCandle){
      const current=candles.get(liveCandle.time);
      candles.set(liveCandle.time,current?mergeBars(current,liveCandle):normalizeBar(liveCandle));
    }
    const added=candles.size-previousSize;
    paintCandles(false);
    $("candle-count").textContent=String(candles.size);
    if(visibleRange&&added>0){
      chart.timeScale().setVisibleLogicalRange({
        from:visibleRange.from+added,
        to:visibleRange.to+added
      });
    }
    if(rows.length===0||added===0)endHistory();
  }
  function requestMoreHistory(){
    if(historyLoading||!initialHistoryLoaded||!hasMoreHistory)return;
    if(sendBridge({action:"loadMore"}))setHistoryLoading(true);
  }
  function normalizeBar(bar){return {time:Math.floor(Number(bar.time)),open:Number(bar.open),high:Number(bar.high),low:Number(bar.low),close:Number(bar.close)};}
  function mergeBars(oldBar,newBar){return {time:newBar.time,open:oldBar.open,high:Math.max(oldBar.high,newBar.high),low:Math.min(oldBar.low,newBar.low),close:newBar.close};}
  function sortedBars(){return Array.from(candles.values()).filter(bar=>Number.isFinite(bar.time)&&Number.isFinite(bar.close)).sort((a,b)=>a.time-b.time);}
  function paintCandles(fit){const rows=sortedBars();candleSeries.setData(rows);updateIndicators();if(fit)chart.timeScale().fitContent();if(rows.length){emptyNode.classList.add("hidden");$("data-state").textContent="LIVE";$("data-state").classList.add("live");}}
  function updateIndicators(){
    const rows=sortedBars(),smaOn=$("sma-toggle").checked,emaOn=$("ema-toggle").checked;
    smaSeries.applyOptions({visible:smaOn});emaSeries.applyOptions({visible:emaOn});
    if(smaOn){const period=20,points=[];let sum=0;for(let i=0;i<rows.length;i++){sum+=rows[i].close;if(i>=period)sum-=rows[i-period].close;if(i>=period-1)points.push({time:rows[i].time,value:sum/period});}smaSeries.setData(points);}
    if(emaOn){const period=50,alpha=2/(period+1),points=[];let ema=null;for(const row of rows){ema=ema===null?row.close:row.close*alpha+ema*(1-alpha);points.push({time:row.time,value:ema});}emaSeries.setData(points);}
  }
  function updatePrice(price){if(!Number.isFinite(price))return;const digits=activeAsset.includes("JPY")?3:activeAsset.includes("BTC")?2:5;$("last-price").textContent=price.toFixed(digits);$("price-time").textContent=new Date().toLocaleTimeString();}
  function setPeriod(period){
    activePeriod=Number(period);$("period-state").textContent=periodNames[activePeriod]||String(activePeriod)+"s";
    document.querySelectorAll(".tf-button").forEach(button=>button.classList.toggle("active",Number(button.dataset.period)===activePeriod));
    resetMarketData();if(brokerConnected)sendBridge({action:"subscribe",asset:activeAsset,period:activePeriod});
  }
  function setAsset(asset){
    activeAsset=asset;const option=$("asset-select").selectedOptions[0];
    $("chart-title").innerHTML=escapeHtml(option?option.textContent:asset)+' <span class="otc-pill">OTC</span>';
    $("symbol-state").textContent=asset;resetMarketData();
    if(brokerConnected)sendBridge({action:"subscribe",asset:activeAsset,period:activePeriod});
  }
  function resetMarketData(){
    candles.clear();liveCandle=null;candleSeries.setData([]);smaSeries.setData([]);emaSeries.setData([]);
    initialHistoryLoaded=false;historyLoading=false;hasMoreHistory=true;autoLoadArmed=false;
    $("last-price").textContent="—";$("price-time").textContent="ожидание потока";$("candle-count").textContent="0";$("update-state").textContent="—";
    $("data-state").textContent="ОЖИДАНИЕ";$("data-state").classList.remove("live");emptyNode.classList.remove("hidden");
    setHistoryLoading(false);
  }
  function escapeHtml(value){return String(value).replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));}
  function setTool(tool){
    activeTool=tool;trendStart=null;
    document.querySelectorAll(".tool-button[data-tool]").forEach(button=>button.classList.toggle("active",button.dataset.tool===tool));
    const hints={cursor:"Курсор · перетаскивай график и используй колёсико для масштаба",hline:"Уровень · нажми на график, чтобы поставить горизонтальную линию",trend:"Линия тренда · выбери первую точку"};
    $("tool-hint").textContent=hints[tool];chart.applyOptions({handleScroll:{pressedMouseMove:tool==="cursor"}});
  }
  function toUnix(time){
    if(typeof time==="number")return time;
    if(time&&typeof time==="object"&&"year" in time)return Math.floor(Date.UTC(time.year,time.month-1,time.day)/1000);
    return null;
  }
  chart.subscribeClick(param=>{
    if(activeTool==="cursor"||!param.point)return;
    const price=candleSeries.coordinateToPrice(param.point.y),time=toUnix(chart.timeScale().coordinateToTime(param.point.x));
    if(price==null||time==null||!Number.isFinite(price))return;
    if(activeTool==="hline"){
      const line=candleSeries.createPriceLine({price,color:"#e5b75e",lineWidth:1,lineStyle:LightweightCharts.LineStyle.Dashed,axisLabelVisible:true,title:"Уровень"});
      priceLines.push(line);
    }else if(activeTool==="trend"){
      if(!trendStart){trendStart={time,price};$("tool-hint").textContent="Линия тренда · выбери вторую точку";}
      else{
        const points=[{time:trendStart.time,value:trendStart.price},{time,value:price}].sort((a,b)=>a.time-b.time);
        if(points[0].time!==points[1].time){const line=chart.addLineSeries({color:"#7fb8f4",lineWidth:2,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:true});line.setData(points);drawingSeries.push(line);}
        trendStart=null;$("tool-hint").textContent="Линия тренда добавлена · выбери следующую пару точек";
      }
    }
  });
  chart.timeScale().subscribeVisibleLogicalRangeChange(range=>{
    if(!autoLoadArmed||!range||!initialHistoryLoaded||historyLoading||!hasMoreHistory)return;
    if(range.from<=2){
      autoLoadArmed=false;
      requestMoreHistory();
    }
  });
  chartNode.addEventListener("wheel",()=>{autoLoadArmed=true;},{passive:true});
  chartNode.addEventListener("pointerdown",()=>{autoLoadArmed=true;});
  $("load-history-button").addEventListener("click",requestMoreHistory);
  $("timeframes").addEventListener("click",event=>{const button=event.target.closest(".tf-button");if(button)setPeriod(button.dataset.period);});
  $("asset-select").addEventListener("change",event=>setAsset(event.target.value));
  $("sma-toggle").addEventListener("change",updateIndicators);
  $("ema-toggle").addEventListener("change",updateIndicators);
  document.querySelectorAll(".tool-button[data-tool]").forEach(button=>button.addEventListener("click",()=>setTool(button.dataset.tool)));
  $("clear-drawings").addEventListener("click",()=>{
    for(const line of priceLines)candleSeries.removePriceLine(line);
    for(const series of drawingSeries)chart.removeSeries(series);
    priceLines=[];drawingSeries=[];trendStart=null;$("tool-hint").textContent="Все пользовательские рисунки удалены";
  });
  $("fit-button").addEventListener("click",()=>chart.timeScale().fitContent());
  connectButton.addEventListener("click",()=>{
    const authFrame=authInput.value.trim();
    if(!authFrame){setStatus("Вставь полный кадр авторизации Pocket Option.","error");authInput.focus();return;}
    if(!sendBridge({action:"connect",authFrame}))return;
    authInput.value="";
    connectButton.disabled=true;setTimeout(()=>{connectButton.disabled=false;},3000);
  });
  disconnectButton.addEventListener("click",()=>{sendBridge({action:"disconnect"});brokerConnected=false;disconnectButton.disabled=true;resetMarketData();});
  window.addEventListener("beforeunload",()=>{if(socket&&socket.readyState===WebSocket.OPEN){socket.send(JSON.stringify({action:"disconnect"}));socket.close();}});
  $("symbol-state").textContent=activeAsset;$("period-state").textContent=periodNames[activePeriod];
  setHistoryLoading(false);
  openBridge();
})();