const $=id=>document.getElementById(id);let imported=[],lastReport=null;
const settings=()=>({threshold:+$("threshold").value,lookback:+$("lookback").value,minSamples:+$("minSamples").value,payout:+$("payout").value,crossAsset:$("crossAsset").checked,paper:$("paper").checked});
$("threshold").addEventListener("input",()=> $("thresholdOut").textContent=$("threshold").value+"%");
$("file").addEventListener("change",e=>loadFile(e.target.files[0]));
$("drop").addEventListener("dragover",e=>e.preventDefault());
$("drop").addEventListener("drop",e=>{e.preventDefault();loadFile(e.dataTransfer.files[0]);});
function loadFile(file){if(!file)return;if(file.size>100*1024*1024){$("result").textContent="Файл больше 100 МБ";return;}const reader=new FileReader();reader.onload=()=>{try{const lines=String(reader.result).trim().split(/\r?\n/);const head=lines.shift().toLowerCase().split(",").map(x=>x.trim());const ix=k=>head.indexOf(k);for(const k of ["open","high","low","close"])if(ix(k)<0)throw Error("Нет колонки "+k);imported=lines.map(line=>{const v=line.split(",");return {time:v[ix("time")]||v[0],open:+v[ix("open")],high:+v[ix("high")],low:+v[ix("low")],close:+v[ix("close")],volume:ix("volume")>=0?+v[ix("volume")]:0};}).filter(c=>[c.open,c.high,c.low,c.close].every(Number.isFinite)&&c.high>=Math.max(c.open,c.close)&&c.low<=Math.min(c.open,c.close));$("history").textContent=imported.length.toLocaleString("ru-RU");$("result").textContent="Загружено "+imported.length+" корректных свечей. Нажмите «Анализировать CSV»."; }catch(err){$("result").textContent="Ошибка CSV: "+err.message;}};reader.readAsText(file);}
$("analyze").addEventListener("click",()=>{if(!imported.length){$("result").textContent="Сначала загрузите CSV.";return;}lastReport=PatternLabEngine.analyze(imported,settings());const r=lastReport;$("matches").textContent=r.matchCount??r.matches??"—";$("similarity").textContent=r.similarity==null?"—":(r.similarity*100).toFixed(1)+"%";$("winrate").textContent=r.best?(r.best.winRate*100).toFixed(1)+"%":"—";$("result").textContent=r.status==="ready"?("Лучший горизонт: "+r.best.horizon+" свечей ("+(r.best.horizon*5)+" сек). Направление: "+r.best.direction+". Исходов: "+r.best.count+". "+r.note):r.message;});
$("export").addEventListener("click",()=>{if(!lastReport){$("result").textContent="Сначала выполните анализ.";return;}const blob=new Blob([JSON.stringify({settings:settings(),report:lastReport},null,2)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="pattern-lab-report.json";a.click();URL.revokeObjectURL(a.href);});
chrome.storage.local.get("patternLabSettings",r=>{const s=r.patternLabSettings;if(!s)return;$("threshold").value=s.threshold??80;$("thresholdOut").textContent=$("threshold").value+"%";$("lookback").value=s.lookback??8;$("minSamples").value=s.minSamples??30;$("payout").value=s.payout??90;$("crossAsset").checked=s.crossAsset??true;$("paper").checked=true;});
window.addEventListener("beforeunload",()=>chrome.storage.local.set({patternLabSettings:settings()}));
async function getActiveTabStatus(){
  try{
    const tabs=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tabs[0]?.id)return null;
    return await chrome.tabs.sendMessage(tabs[0].id,{type:"PPL_GET_STATUS"});
  }catch(_){return null;}
}
async function refreshLiveStatus(){
  const s=await getActiveTabStatus();
  const pill=document.querySelector("header .pill");
  if(!s){
    pill.textContent="● ОТКРОЙТЕ POCKET OPTION";
    pill.className="pill offline";
    $("liveStatus").textContent="Откройте авторизованную вкладку Pocket Option и обновите её после установки расширения.";
    return;
  }
  pill.textContent=s.connected?"● СОЕДИНЕНИЕ ОБНАРУЖЕНО":"● ОЖИДАНИЕ ПОТОКА";
  pill.className="pill "+(s.connected?"online":"offline");
  $("liveStatus").textContent=
    "Сокетов: "+s.sockets+" · событий: "+s.events+" · тиков: "+s.ticks+
    " · свечей в базе: "+(s.storedCandles||0)+
    (s.lastError?" · "+s.lastError:"");
  if(s.storedCandles!=null)$("history").textContent=Number(s.storedCandles).toLocaleString("ru-RU");
  if(s.assets!=null)$("coverage").textContent="Каталог: "+s.assets;
}
$("liveAnalyze").addEventListener("click",async()=>{
  try{
    const tabs=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tabs[0]?.id)throw Error("Нет активной вкладки");
    const data=await chrome.tabs.sendMessage(tabs[0].id,{type:"PPL_GET_CANDLES"});
    if(!data?.ok)throw Error(data?.error||"Не удалось прочитать базу");
    const candles=(data.candles||[]).filter(c=>c.period===5).sort((a,b)=>a.time-b.time);
    if(!candles.length)throw Error("Пока нет 5-секундных свечей. Оставьте график открытым.");
    lastReport=PatternLabEngine.analyze(candles,settings());
    const r=lastReport;
    $("matches").textContent=r.matchCount??r.matches??"—";
    $("similarity").textContent=r.similarity==null?"—":(r.similarity*100).toFixed(1)+"%";
    $("winrate").textContent=r.best?(r.best.winRate*100).toFixed(1)+"%":"—";
    $("result").textContent=r.status==="ready"
      ?("Live-история: "+candles.length+" свечей. Лучший горизонт: "+r.best.horizon+" свечей ("+(r.best.horizon*5)+" сек). Направление: "+r.best.direction+". Исходов: "+r.best.count+". "+r.note)
      :("Live-история: "+candles.length+" свечей. "+r.message);
  }catch(err){$("result").textContent=err.message;}
});
refreshLiveStatus();
setInterval(refreshLiveStatus,2500);
