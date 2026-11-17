const DB_NAME = "pocket-data-collector";
const DB_VERSION = 1;
const STORE = "candles";
const states = new Map();
const tabMeta = new Map();

function dbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: "id" });
        s.createIndex("asset_time", ["asset", "time"], { unique: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
let dbPromise;
const db = () => dbPromise ||= dbOpen();

function normAsset(v) {
  return String(v || "").trim().toUpperCase().replace(/\s+/g, "").replace(/\/$/, "");
}
function epochMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? Math.floor(n) : Math.floor(n * 1000);
}
function validBar(c) {
  return c && [c.open,c.high,c.low,c.close].every(Number.isFinite) &&
    c.open > 0 && c.high >= Math.max(c.open,c.close) &&
    c.low <= Math.min(c.open,c.close) && c.low > 0;
}
function getState(tabId) {
  if (!states.has(tabId)) states.set(tabId, {
    connected:false, sockets:0, openSockets:0, events:0, ticks:0,
    pair:"UNKNOWN", balance:null, balanceSource:null, accountType:null,
    lastEventAt:0, lastTickAt:0, lastError:"", catalogCount:0,
    chartPeriod:null, frameStates:{}
  });
  return states.get(tabId);
}
async function putMany(rows) {
  if (!rows.length) return 0;
  const database = await db();
  return new Promise((resolve,reject) => {
    const tx = database.transaction(STORE,"readwrite");
    const store = tx.objectStore(STORE);
    for (const row of rows) store.put(row);
    tx.oncomplete = () => resolve(rows.length);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
function mergeCandle(oldBar,newBar) {
  if (!oldBar) return newBar;
  if (newBar.source === "history" && oldBar.source !== "history") {
    return {...newBar,ticks:oldBar.ticks||0};
  }
  if (newBar.source === "tick-stream") {
    return {...oldBar,high:Math.max(oldBar.high,newBar.high),
      low:Math.min(oldBar.low,newBar.low),close:newBar.close,
      ticks:(oldBar.ticks||0)+(newBar.ticks||0),
      source:oldBar.source==="history"?"history+tick-stream":"tick-stream"};
  }
  return {...newBar,ticks:Math.max(oldBar.ticks||0,newBar.ticks||0)};
}
function tickRows(payload) {
  const rows = Array.isArray(payload) ? payload : [payload];
  const out = [];
  for (const row of rows) {
    if (Array.isArray(row) && typeof row[0] === "string" && row.length >= 3) {
      const asset = normAsset(row[0]), time = epochMs(row[1]), price = Number(row[2]);
      if (asset && time && price > 0) out.push({asset,time,price});
    } else if (row && typeof row === "object" && row.asset && Array.isArray(row.prices)) {
      for (const tick of row.prices) {
        const asset=normAsset(row.asset),time=epochMs(tick.time ?? tick.t),price=Number(tick.price ?? tick.p);
        if(asset&&time&&price>0)out.push({asset,time,price});
      }
    } else if (row && typeof row === "object" && row.asset) {
      const asset=normAsset(row.asset),time=epochMs(row.time ?? row.timestamp ?? row.t),price=Number(row.price ?? row.close ?? row.p);
      if(asset&&time&&price>0)out.push({asset,time,price});
    }
  }
  return out;
}
async function storeTicks(tabId, ticks) {
  if (!ticks.length) return;
  const state=getState(tabId), updates=new Map();
  ticks=[...ticks].sort((a,b)=>a.time-b.time);
  for(const t of ticks){
    const bucket=Math.floor(t.time/5000)*5000;
    const id=t.asset+"|5|"+bucket;
    let bar=updates.get(id);
    if(!bar)bar={id,asset:t.asset,period:5,time:bucket,open:t.price,high:t.price,low:t.price,close:t.price,ticks:1,source:"tick-stream"};
    else {bar.high=Math.max(bar.high,t.price);bar.low=Math.min(bar.low,t.price);bar.close=t.price;bar.ticks++;}
    updates.set(id,bar);
    state.ticks++;
    state.lastTickAt=Math.max(state.lastTickAt,t.time);
  }
  // Merge with any candle already stored for the same 5-second interval.
  const database=await db();
  const existing=await Promise.all([...updates.keys()].map(id=>new Promise(resolve=>{
    const req=database.transaction(STORE).objectStore(STORE).get(id);
    req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>resolve(null);
  })));
  for(let i=0;i<existing.length;i++){
    const old=existing[i],fresh=updates.get([...updates.keys()][i]);
    if(old)updates.set([...updates.keys()][i],mergeCandle(old,fresh));
  }
  await putMany([...updates.values()]);
}
function detectLayout(rows) {
  if (rows.some(r => r && !Array.isArray(r) && typeof r === "object" &&
    (r.open != null || r.o != null) && (r.high != null || r.h != null) &&
    (r.low != null || r.l != null) && (r.close != null || r.c != null))) return {objectRows:true};
  let ohlc=0,ochl=0,checked=0;
  for(const r of rows.slice(0,60)){
    if(!Array.isArray(r)||r.length<5)continue;
    const a=Number(r[1]),b=Number(r[2]),c=Number(r[3]),d=Number(r[4]);
    if(![a,b,c,d].every(Number.isFinite)||Math.min(a,b,c,d)<=0)continue;
    checked++;const hi=Math.max(a,b,c,d),lo=Math.min(a,b,c,d);
    if(b>=hi&&c<=lo)ohlc++;
    if(c>=hi&&d<=lo)ochl++;
  }
  if(ohlc>0&&ohlc>=ochl)return {o:1,h:2,l:3,c:4};
  if(ochl>0)return {o:1,h:3,l:4,c:2};
  return null;
}
async function storeHistory(payload) {
  const data=Array.isArray(payload)?payload[0]:payload;
  if(!data||!data.asset||!Array.isArray(data.history||data.data||data.candles))return 0;
  const rows=data.history||data.data||data.candles;
  const period=Number(data.period||0);
  if(!period)return 0;
  const layout=detectLayout(rows);
  if(!layout)return 0; // Price-only arrays are not falsely labelled OHLC.
  const asset=normAsset(data.asset),out=[];
  for(const row of rows){
    let c=null;
    if(Array.isArray(row)&&row.length>=5&&!layout.objectRows){
      c={time:epochMs(row[0]),open:Number(row[layout.o]),high:Number(row[layout.h]),low:Number(row[layout.l]),close:Number(row[layout.c]),ticks:0,source:"history"};
    }else if(row&&typeof row==="object"){
      c={time:epochMs(row.time??row.t??row.ts),open:Number(row.open??row.o),high:Number(row.high??row.h),low:Number(row.low??row.l),close:Number(row.close??row.c),ticks:0,source:"history"};
    }
    if(!c||!c.time||!validBar(c))continue;
    c.time=Math.floor(c.time/(period*1000))*period*1000;
    c.asset=asset;c.period=period;c.id=asset+"|"+period+"|"+c.time;
    out.push(c);
  }
  const deduped=[...new Map(out.map(c=>[c.id,c])).values()].sort((a,b)=>a.time-b.time);
  const database=await db();
  const existing=await Promise.all(deduped.map(c=>new Promise(resolve=>{
    const req=database.transaction(STORE).objectStore(STORE).get(c.id);
    req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>resolve(null);
  })));
  const merged=deduped.map((c,i)=>mergeCandle(existing[i],c));
  await putMany(merged);return merged.length;
}
async function queryCandles({asset,limit=10000,period=5}) {
  const database=await db();
  const all=await new Promise((resolve,reject)=>{
    const req=database.transaction(STORE).objectStore(STORE).getAll();
    req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error);
  });
  const filtered=all.filter(c=>(!asset||c.asset===asset)&&(!period||c.period===period)).sort((a,b)=>a.time-b.time);
  return filtered.slice(-Math.max(1,Math.min(100000,Number(limit)||10000)));
}
async function getDbStats(asset=null) {
  const database=await db();
  const all=await new Promise((resolve,reject)=>{
    const req=database.transaction(STORE).objectStore(STORE).getAll();
    req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error);
  });
  const pair=normAsset(asset);
  const pairRows=pair?all.filter(c=>c.asset===pair&&c.period===5):[];
  const assets=[...new Set(all.map(c=>c.asset).filter(Boolean))].sort();
  return {
    total:all.length,
    pair5:pairRows.length,
    assets:assets.length,
    byPeriod:all.reduce((a,c)=>(a[c.period]=(a[c.period]||0)+1,a),{})
  };
}
async function getIntegrity(asset,period=5) {
  const rows=await queryCandles({asset,period,limit:100000});
  const step=Number(period)*1000;
  let gaps=0,missing=0,maxGapMs=0,duplicates=0;
  const gapSamples=[];
  for(let i=1;i<rows.length;i++){
    const delta=rows[i].time-rows[i-1].time;
    if(delta===0){duplicates++;continue;}
    if(delta>step){
      const absent=Math.max(0,Math.round(delta/step)-1);
      gaps++;missing+=absent;maxGapMs=Math.max(maxGapMs,delta-step);
      if(gapSamples.length<30)gapSamples.push({from:rows[i-1].time,to:rows[i].time,missingCandles:absent,durationSec:Math.round(delta/1000)});
    }
  }
  return {asset:asset||null,period,total:rows.length,gaps,duplicates,missingCandles:missing,
    maxGapSec:Math.round(maxGapMs/1000),
    coverage:rows.length>1?Math.max(0,1-missing/(rows.length+missing-1)):null,
    firstTime:rows[0]?.time||null,lastTime:rows.at(-1)?.time||null,gapSamples};
}
function getStatus(tabId) {
  const s=getState(tabId);
  const frames=Object.values(s.frameStates);
  const open=frames.some(x=>x.openSockets>0);
  return {
    connected:open,
    sockets:frames.reduce((n,x)=>n+(x.openSockets||0),0),
    events:s.events,ticks:s.ticks,pair:s.pair,balance:s.balance,
    balanceSource:s.balanceSource,accountType:s.accountType,
    lastEventAt:s.lastEventAt,lastTickAt:s.lastTickAt,
    catalogCount:s.catalogCount,chartPeriod:s.chartPeriod,
    lastError:s.lastError,storedCandles:null
  };
}
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
  (async()=>{
    const tabId=msg.tabId ?? sender.tab?.id;
    if(msg.type==="PDC_CONTENT_READY")return {ok:true};
    if(msg.type==="PDC_PAGE_MESSAGE"){
      if(tabId==null)return {ok:false};
      const s=getState(tabId),frameId=sender.frameId??0,key=String(frameId);
      const f=s.frameStates[key] ||= {openSockets:0,lastEventAt:0};
      if(msg.kind==="SOCKET"){
        f.openSockets=msg.payload?.openSockets ?? (msg.payload?.state==="open"?1:0);
        f.lastSocketAt=Date.now();
        s.lastEventAt=f.lastSocketAt;
      }else if(msg.kind==="PAGE_STATE"){
        if(msg.isTop){
          const p=msg.payload||{};
          if(p.pair&&p.pair!=="UNKNOWN")s.pair=p.pair;
          if(p.balance?.value!=null){s.balance=p.balance.value;s.balanceSource="page";}
        }
      }else if(msg.kind==="PO_EVENT"){
        const ev=msg.payload||{},name=ev.name,p=ev.payload;
        s.events++;s.lastEventAt=Date.now();f.lastEventAt=s.lastEventAt;
        if(name==="successauth"||name==="user_ready"){
          const a=Array.isArray(p)?p[0]:p;
          if(a&&typeof a==="object"){
            const bal=Number(a.balance??a.demo_balance??a.real_balance??a.amount);
            if(Number.isFinite(bal)&&bal>=0){s.balance=bal;s.balanceSource="websocket";}
            const d=a.is_demo??a.isDemo??a.demo_account??a.isDemoAccount;
            if(d===true||d===1||d==="1")s.accountType="DEMO";
            else if(d===false||d===0||d==="0")s.accountType="REAL";
          }
        }else if(name==="updateAssets"){
          const rows=Array.isArray(p)?p:(p?.assets||[p]);s.catalogCount=rows.filter(Boolean).length;
        }else if(name==="updateCharts"){
          const rows=Array.isArray(p)?p:[p];
          for(const row of rows){let settings=row?.settings;if(typeof settings==="string"){try{settings=JSON.parse(settings)}catch(_){}}const n=Number(settings?.chartPeriod||settings?.fastTimeframe||0);if(n>0)s.chartPeriod=n;}
        }else if(name==="updateStream"||name==="quotes/stream"){
          const ticks=tickRows(p);await storeTicks(tabId,ticks);
        }else if(["history/list/v2","updateHistoryNew","updateHistoryNewFast","loadHistoryPeriod","loadHistoryPeriodFast"].includes(name)){
          const n=await storeHistory(p);if(!n&&Array.isArray((Array.isArray(p)?p[0]:p)?.history))s.lastError="Получена история без подтверждённых OHLC-полей; тики продолжат формировать 5s свечи.";
        }
      }else if(msg.kind==="BRIDGE_ERROR"){s.lastError=msg.payload?.message||"Ошибка bridge";}
      return {ok:true};
    }
    if(msg.type==="PDC_GET_STATUS"){
      if(tabId==null)return {ok:false};
      const status=getStatus(tabId);
      const stats=await getDbStats(status.pair);
      status.storedCandles=stats.total;
      status.pairCandles=stats.pair5;
      status.assetCount=stats.assets;
      status.byPeriod=stats.byPeriod;
      return {ok:true,...status};
    }
    if(msg.type==="PDC_GET_CANDLES"){
      const candles=await queryCandles(msg);
      return {ok:true,candles};
    }
    if(msg.type==="PDC_EXPORT"){
      return {ok:true,candles:await queryCandles({limit:msg.limit||100000,period:msg.period??0,asset:msg.asset||null})};
    }
    if(msg.type==="PDC_DB_STATS"){
      return {ok:true,...await getDbStats(msg.asset||null)};
    }
    if(msg.type==="PDC_GET_INTEGRITY"){
      const status=getStatus(tabId);
      return {ok:true,...await getIntegrity(msg.asset||status.pair,Number(msg.period)||5)};
    }
    return {ok:false,error:"Unknown request"};
  })().then(reply).catch(error=>reply({ok:false,error:String(error?.message||error)}));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId=>{states.delete(tabId);tabMeta.delete(tabId);});