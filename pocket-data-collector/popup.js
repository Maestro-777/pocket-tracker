const $=id=>document.getElementById(id);
let lastStatus=null,lastCandles=[];
const number=n=>Number(n||0).toLocaleString("ru-RU");
function setConnection(ok,text){
  $("connection").className="status "+(ok?"online":"offline");
  $("connection").textContent=ok?"● ПОДКЛЮЧЕНО":"● НЕТ СОЕДИНЕНИЯ";
  $("connectionText").textContent=text;
}
async function activeTab(){
  const tabs=await chrome.tabs.query({active:true,currentWindow:true});
  return tabs[0]?.id??null;
}
async function refresh(){
  const tabId=await activeTab();
  if(tabId==null){setConnection(false,"Не найдена активная вкладка.");return;}
  const s=await chrome.runtime.sendMessage({type:"PDC_GET_STATUS",tabId});
  if(!s?.ok){setConnection(false,"Не удалось получить состояние сборщика.");return;}
  lastStatus=s;
  setConnection(!!s.connected,s.connected
    ?"WebSocket Pocket Option активен. Последнее событие: "+(s.lastEventAt?new Date(s.lastEventAt).toLocaleTimeString():"—")
    :"Вкладка найдена, но WebSocket ещё не подтверждён. Обновите страницу Pocket Option.");
  $("pair").textContent=s.pair&&s.pair!=="UNKNOWN"?s.pair:"Не определена";
  $("balance").textContent=s.balance==null?"—":Number(s.balance).toLocaleString("ru-RU",{minimumFractionDigits:2,maximumFractionDigits:2});
  $("accountType").textContent=(s.accountType||"тип счёта неизвестен")+(s.balanceSource?" · "+s.balanceSource:"");
  $("stored").textContent=number(s.storedCandles);
  $("stored").title=number(s.pairCandles)+" свечей текущей пары · "+number(s.assetCount)+" пар в базе";
  $("ticks").textContent=number(s.ticks);
  $("pairStored").textContent=number(s.pairCandles);
  $("events").textContent=number(s.events);
  if(s.lastError)$("analysis").textContent=s.lastError;const a=s.auto||{};$("autoStatus").textContent="Статус: "+(a.enabled?"ВКЛЮЧЕНА":"выключена")+". Счёт: "+(s.accountType||"не подтверждён")+". Сделок: "+(a.trades||0)+"/"+(a.maxTrades||3)+". "+(a.lastResult||"");$("autoStart").disabled=!!a.enabled;$("autoStop").disabled=!a.enabled;
}
function download(name,text,type){
  const blob=new Blob([text],{type}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function getData(){
  const tabId=await activeTab();
  if(tabId==null)throw Error("Откройте вкладку Pocket Option.");
  const limit=Math.max(30,Math.min(100000,Number($("candleCount").value)||2000));
  const asset=lastStatus?.pair&&lastStatus.pair!=="UNKNOWN"?lastStatus.pair:null;
  const r=await chrome.runtime.sendMessage({type:"PDC_GET_CANDLES",tabId,asset,period:5,limit});
  if(!r?.ok)throw Error(r?.error||"Не удалось получить свечи.");
  return r.candles||[];
}
$("autoStart").addEventListener("click",async()=>{try{const tabId=await activeTab();const amount=Number($("autoAmount").value),maxTrades=Number($("autoMaxTrades").value);if(!(amount>0&&amount<=1))throw Error("Ставка должна быть от 0.01 до 1.00.");if(!(maxTrades>=1&&maxTrades<=3))throw Error("Допустимо не более 3 сделок за запуск.");const r=await chrome.runtime.sendMessage({type:"PDC_AUTO_TOGGLE",tabId,enabled:true,amount,maxTrades});if(!r?.ok)throw Error(r?.error||"Не удалось запустить автоторговлю.");await refresh();}catch(e){$("autoStatus").textContent=e.message;}});$("autoStop").addEventListener("click",async()=>{try{const tabId=await activeTab();const r=await chrome.runtime.sendMessage({type:"PDC_AUTO_TOGGLE",tabId,enabled:false});if(!r?.ok)throw Error(r?.error||"Не удалось остановить.");await refresh();}catch(e){$("autoStatus").textContent=e.message;}});$("threshold").addEventListener("input",()=> $("thresholdOut").textContent=$("threshold").value+"%");
$("analyze").addEventListener("click",async()=>{
  try{
    const candles=await getData();lastCandles=candles;
    if(candles.length<30){$("analysis").textContent="Недостаточно 5-секундных свечей. Получено: "+candles.length+". Оставьте график открытым для накопления тиков.";return;}
    const r=PocketCollectorEngine.findSimilar(candles,{
      patternLength:Number($("patternLength").value),
      threshold:Number($("threshold").value),
      resultLimit:Number($("resultLimit").value)
    });
    $("matchCount").textContent=number(r.totalMatches)+" совпадений";
    if(r.status==="gaps"){ $("analysis").textContent=r.message+" Получено "+number(candles.length)+" свечей."; return; }
    $("analysis").textContent="В выборку вошло "+number(candles.length)+" из "+number(lastStatus?.pairCandles||0)+
      " свечей текущей пары. Проверено "+number(r.validWindows||0)+" непрерывных исторических окон; пропущено из-за разрывов: "+
      number(r.skippedGaps||0)+". Длина паттерна: "+r.patternLength+" свечей. Порог сходства: "+
      r.threshold.toFixed(0)+"%. Это поиск похожих участков, не прогноз вероятности выигрыша.";
    $("matches").innerHTML="";
    if(!r.matches.length){$("matches").innerHTML='<div class="empty">Совпадений выше заданного порога не найдено.</div>';return;}
    for(const m of r.matches){
      const item=document.createElement("div");item.className="match";
      const date=m.time?new Date(m.time).toLocaleString():"Время неизвестно";
      item.innerHTML='<div><b>'+date+'</b><small>Следующая свеча в истории: '+m.nextDirection+'</small></div><strong>'+Math.round(m.similarity*1000)/10+'%</strong>';
      $("matches").append(item);
    }
  }catch(e){$("analysis").textContent=e.message;}
});
$("checkIntegrity").addEventListener("click",async()=>{
  try{
    const tabId=await activeTab();
    const asset=lastStatus?.pair&&lastStatus.pair!=="UNKNOWN"?lastStatus.pair:null;
    const r=await chrome.runtime.sendMessage({type:"PDC_GET_INTEGRITY",tabId,asset,period:5});
    if(!r?.ok)throw Error(r?.error||"Не удалось проверить историю.");
    const coverage=r.coverage==null?"—":(r.coverage*100).toFixed(2)+"%";
    const first=r.firstTime?new Date(r.firstTime).toLocaleString():"—";
    const last=r.lastTime?new Date(r.lastTime).toLocaleString():"—";
    const worst=r.gapSamples?.length?r.gapSamples.reduce((a,b)=>a.durationSec>b.durationSec?a:b):null;
    $("integrityResult").textContent="Пара: "+(r.asset||"все пары")+". Свечей: "+number(r.total)+". Разрывов: "+number(r.gaps)+". Отсутствует 5-секундных интервалов: "+number(r.missingCandles)+". Максимальный разрыв: "+number(r.maxGapSec)+" сек. Расчётное покрытие временной сетки: "+coverage+". Дубликатов времени: "+number(r.duplicates)+". Первая свеча: "+first+". Последняя: "+last+"."+(worst?" Самый длинный показанный разрыв: "+new Date(worst.from).toLocaleString()+" → "+new Date(worst.to).toLocaleString()+" ("+worst.durationSec+" сек).":"");
  }catch(e){$("integrityResult").textContent=e.message;}
});
$("detectSignal").addEventListener("click",async()=>{
  try{
    const candles=await getData();
    if(candles.length<100){
      $("signalResult").textContent="Для оценки исходов на экспирации 15 секунд пока мало истории. Продолжайте собирать 5-секундные свечи.";
      return;
    }
    const expirySec=Math.max(1,Math.min(300,Number($("expirySec").value)||15));
    const minSamples=Math.max(5,Math.min(200,Number($("minSamples").value)||20));
    const r=PocketCollectorEngine.evaluateExpiry(candles,{expirySec,minSamples,threshold:Number($("threshold").value)});
    if(r.status!=="ready"){
      $("signalResult").textContent=r.message||"Недостаточно данных для сигнала.";
      return;
    }
    const c=r.chosen;
    const direction=r.signal==="UP"?"ВВЕРХ":r.signal==="DOWN"?"ВНИЗ":"НЕТ СИГНАЛА";
    $("signalResult").textContent="Результат: "+direction+". Паттерн: "+c.patternLength+" свечей (подобран автоматически). Экспирация: "+r.expirySec+" сек. Исторических аналогов: "+c.samples+"; вверх: "+c.up+", вниз: "+c.down+", без изменения: "+c.flat+". Доля верного направления среди ненулевых исходов: "+(c.winRate*100).toFixed(1)+"%. Порог сходства: "+r.threshold+"%. "+r.disclaimer+" Автоисполнение ордеров пока выключено.";
  }catch(e){$("signalResult").textContent=e.message;}
});
$("exportCsv").addEventListener("click",async()=>{
  try{
    const candles=await getData();
    if(!candles.length)throw Error("Нет свечей для экспорта.");
    const rows=["asset,period,time,open,high,low,close,ticks,source",...candles.map(c=>
      [c.asset,c.period,new Date(c.time).toISOString(),c.open,c.high,c.low,c.close,c.ticks||0,c.source||""].join(",")
    )];
    download("pocket-candles.csv",rows.join("\n"),"text/csv;charset=utf-8");
  }catch(e){$("analysis").textContent=e.message;}
});
$("exportJson").addEventListener("click",async()=>{
  try{
    const tabId=await activeTab();
    const r=await chrome.runtime.sendMessage({type:"PDC_EXPORT",tabId,limit:100000,period:0});
    const candles=r?.candles||[];
    if(!candles.length)throw Error("Локальная история пуста.");
    download("pocket-candles-all.json",JSON.stringify({exportedAt:new Date().toISOString(),count:candles.length,candles},null,2),"application/json");
  }catch(e){$("analysis").textContent=e.message;}
});
$("exportAllCsv").addEventListener("click",async()=>{
  try{
    const tabId=await activeTab();
    const r=await chrome.runtime.sendMessage({type:"PDC_EXPORT",tabId,limit:100000,period:0});
    const candles=r?.candles||[];
    if(!candles.length)throw Error("Локальная история пуста.");
    const rows=["asset,period,time,open,high,low,close,ticks,source",...candles.map(c=>
      [c.asset,c.period,new Date(c.time).toISOString(),c.open,c.high,c.low,c.close,c.ticks||0,c.source||""].map(v=>String(v??"").replaceAll('"','""')).map(v=>/[",\\n]/.test(v)?'"'+v+'"':v).join(",")
    )];
    download("pocket-candles-all.csv",rows.join("\\n"),"text/csv;charset=utf-8");
  }catch(e){$("analysis").textContent=e.message;}
});
refresh();setInterval(refresh,2000);