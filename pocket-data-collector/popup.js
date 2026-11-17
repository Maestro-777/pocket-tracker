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
  $("ticks").textContent=number(s.ticks);
  $("events").textContent=number(s.events);
  if(s.lastError)$("analysis").textContent=s.lastError;
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
$("threshold").addEventListener("input",()=> $("thresholdOut").textContent=$("threshold").value+"%");
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
    $("analysis").textContent="Проанализировано "+number(candles.length)+" свечей · длина паттерна "+r.patternLength+
      " · порог сходства "+r.threshold.toFixed(0)+"%. Это поиск похожих участков, не прогноз вероятности выигрыша.";
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
    const candles=await getData();
    if(!candles.length)throw Error("Нет свечей для экспорта.");
    download("pocket-candles.json",JSON.stringify({exportedAt:new Date().toISOString(),candles},null,2),"application/json");
  }catch(e){$("analysis").textContent=e.message;}
});
refresh();setInterval(refresh,2000);