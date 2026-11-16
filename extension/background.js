"use strict";

/*
 * Pocket Tracker v2. Socket.IO protocol is unofficial and may change.
 * This extension connects ONLY to Pocket Option DEMO endpoints.
 * SSID is held in service-worker memory and never persisted or logged.
 */
const DEMO_URLS=[
 "wss://demo-api-eu.po.market/socket.io/?EIO=4&transport=websocket",
 "wss://try-demo-eu.po.market/socket.io/?EIO=4&transport=websocket"
];
const state={connected:false,authenticated:false,demoVerified:false,account:"unknown",autoTrading:false,
 asset:"EURUSD_otc",period:5,expiry:15,price:null,candleCount:0,rsi:null,lastSignal:null,status:"Расширение готово.",
 candles:[],current:null,ws:null,ssid:null,uid:null,orderPending:false,executionUncertain:false,lastSignalId:null,amount:1};
let pingTimer=null,orderTimer=null;
function publish(message){state.status=message;chrome.runtime.sendMessage({type:"LOG",message}).catch(()=>{});chrome.runtime.sendMessage({type:"STATE"}).catch(()=>{});}
function snapshot(){return {...state,ws:undefined,ssid:undefined,uid:undefined,candles:undefined,current:undefined};}
function event(name,data){if(!state.ws||state.ws.readyState!==WebSocket.OPEN)throw Error("Нет соединения с DEMO-сервером");state.ws.send("42"+JSON.stringify(data===undefined?[name]:[name,data]));}
function stopTimers(){if(pingTimer)clearInterval(pingTimer);pingTimer=null;if(orderTimer)clearTimeout(orderTimer);orderTimer=null;}
function resetConnection(){stopTimers();state.connected=false;state.authenticated=false;state.demoVerified=false;state.account="unknown";state.autoTrading=false;state.orderPending=false;state.executionUncertain=false;state.ws=null;}
function disconnect(message){const ws=state.ws;resetConnection();if(ws&&ws.readyState<2){try{ws.close();}catch{}}publish(message);}
function connect(ssid,uid,asset){
 if(typeof ssid!=="string"||ssid.trim().length<8)throw Error("SSID выглядит некорректно.");
 if(!Number.isSafeInteger(uid)||uid<=0)throw Error("UID должен быть положительным целым числом.");
 if(!/^[A-Za-z0-9_#]{3,32}$/.test(asset))throw Error("Некорректный символ инструмента.");
 if(state.ws)disconnect("Переподключение…");
 state.ssid=ssid.trim();state.uid=uid;state.asset=asset;state.candles=[];state.current=null;state.lastSignalId=null;
 let index=0;
 function tryEndpoint(){
  if(index>=DEMO_URLS.length){state.ssid=null;state.uid=null;publish("Не удалось подключиться к DEMO endpoint. Проверь сеть и попробуй позже.");return;}
  const url=DEMO_URLS[index++];let ws;
  try{ws=new WebSocket(url);}catch(e){tryEndpoint();return;}
  state.ws=ws;
  ws.onopen=()=>{state.connected=true;publish("WebSocket подключён. Ожидаю Socket.IO handshake…");pingTimer=setInterval(()=>{if(ws.readyState===WebSocket.OPEN)ws.send("2");},20000);};
  ws.onmessage=ev=>handleFrame(String(ev.data));
  ws.onerror=()=>{};
  ws.onclose=()=>{if(state.ws!==ws)return;const retry=!state.authenticated&&!state.demoVerified;resetConnection();if(retry&&index<DEMO_URLS.length)tryEndpoint();else publish("Соединение с Pocket Option закрыто. Торговля выключена.");};
 }
 tryEndpoint();
}
function handleFrame(raw){
 if(raw==="2"){try{state.ws.send("3");}catch{}return;}
 if(raw.startsWith("0")){try{state.ws.send("40");}catch{}return;}
 if(raw.startsWith("40")){
  try{event("auth",{session:state.ssid,uid:state.uid,isDemo:1,platform:2,isFastHistory:true,isOptimized:true});publish("Отправлен запрос авторизации. Проверяю ответ сервера…");}catch(e){disconnect(e.message);}return;
 }
 if(raw==="41"){disconnect("Сервер отклонил подключение. Проверь SSID и UID.");return;}
 if(!raw.startsWith("42"))return;
 let packet;try{packet=JSON.parse(raw.slice(2));}catch{return;}
 if(!Array.isArray(packet)||typeof packet[0]!=="string")return;
 const [name,data]=packet;
 if(name==="successauth"){
  state.authenticated=true;
  publish("Авторизация подтверждена. Проверяю тип счёта DEMO…");
  try{event("indicator/load");event("favorite/load");event("price-alert/load");event("updateBalance");event("updateOpenedDeals");}catch(e){publish("Ошибка запроса статуса: "+e.message);}
 }else if(name==="successupdateBalance"&&data&&typeof data==="object"){
  const serverDemo=data.isDemo===true||data.isDemo===1||String(data.isDemo).toLowerCase()==="true"||String(data.isDemo)==="1";
  state.demoVerified=serverDemo&&state.authenticated;state.account=serverDemo?"demo":"real";
  if(!state.demoVerified){state.autoTrading=false;publish("DEMO не подтверждён сервером. Торговля заблокирована.");return;}
  publish("DEMO подтверждён сервером. Подписываюсь на "+state.asset+" · 5 секунд.");
  try{event("changeSymbol",{asset:state.asset,period:5});event("subfor",state.asset);event("loadHistoryPeriod",{asset:state.asset,index:Date.now(),offset:300,period:5,time:Math.floor(Date.now()/1000)});}catch(e){publish("Не удалось подписаться на инструмент: "+e.message);}
 }else if(name==="updateStream"){
  for(const tick of collectTicks(data))if(tick.asset===state.asset)onTick(tick.time,tick.price);
 }else if(name==="loadHistoryPeriodFast"){
  // Historical data is currently diagnostic only; live signal calculation starts from received ticks.
  publish("Исторический ответ получен. Накопление живых 5-секундных свечей…");
 }else if(name==="successopenOrder"){
  state.orderPending=false;state.executionUncertain=false;if(orderTimer)clearTimeout(orderTimer);orderTimer=null;
  publish("Брокер подтвердил открытие сделки.");
 }else if(name==="failopenOrder"){
  state.orderPending=false;state.executionUncertain=false;if(orderTimer)clearTimeout(orderTimer);orderTimer=null;
  state.autoTrading=false;publish("Брокер отклонил ордер. Автоторговля выключена.");
 }else if(name==="successcloseOrder"){
  publish("Сделка закрыта по сообщению брокера.");
 }
}
function toSeconds(v){let n=Number(v);if(!Number.isFinite(n)||n<=0)return null;if(n>1e10)n/=1000;return Math.floor(n);}
function collectTicks(v,hint=null,out=[]){
 if(Array.isArray(v)){
  if(v.length===2&&hint){const t=toSeconds(v[0]),p=Number(v[1]);if(t&&Number.isFinite(p)){out.push({asset:hint,time:t,price:p});return out;}}
  if(v.length>=3&&(typeof v[0]==="string"||typeof v[0]==="number")){const t=toSeconds(v[1]),p=Number(v[2]);if(t&&Number.isFinite(p)){out.push({asset:String(v[0]),time:t,price:p});return out;}}
  for(const x of v)collectTicks(x,hint,out);return out;
 }
 if(v&&typeof v==="object"){
  const asset=v.asset??v.symbol??v.pair??hint,t=toSeconds(v.time??v.timestamp??v.at),p=Number(v.price??v.rate??v.value??v.close);
  if(asset!=null&&t&&Number.isFinite(p)){out.push({asset:String(asset),time:t,price:p});return out;}
  for(const [k,x] of Object.entries(v))collectTicks(x,/^[A-Za-z0-9_#]{3,32}$/.test(k)?k:hint,out);
 }
 return out;
}
function onTick(time,price){
 if(!state.demoVerified||!Number.isFinite(price)||price<=0)return;
 state.price=price;const start=Math.floor(time/5)*5;
 if(!state.current||state.current.time!==start){
  if(state.current){state.candles.push(state.current);if(state.candles.length>300)state.candles.shift();state.candleCount=state.candles.length;evaluate();}
  state.current={time:start,open:price,high:price,low:price,close:price};
 }else{state.current.high=Math.max(state.current.high,price);state.current.low=Math.min(state.current.low,price);state.current.close=price;}
 chrome.runtime.sendMessage({type:"STATE"}).catch(()=>{});
}
function rsiWilder(values,period){
 if(values.length<=period)return null;let gains=0,losses=0;
 for(let i=1;i<=period;i++){const d=values[i]-values[i-1];gains+=Math.max(d,0);losses+=Math.max(-d,0);}
 let ag=gains/period,al=losses/period;
 for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1];ag=(ag*(period-1)+Math.max(d,0))/period;al=(al*(period-1)+Math.max(-d,0))/period;}
 if(al===0)return ag===0?50:100;return 100-100/(1+ag/al);
}
function evaluate(){
 const rows=state.candles;if(rows.length<20)return;
 const last=rows[rows.length-1],window=rows.slice(-20),closes=rows.map(x=>x.close);
 const mean=window.reduce((s,x)=>s+x.close,0)/20;
 const variance=window.reduce((s,x)=>s+(x.close-mean)**2,0)/20,sd=Math.sqrt(variance);
 const upper=mean+2*sd,lower=mean-2*sd,rsi=rsiWilder(closes,14);state.rsi=rsi;
 if(rsi==null)return;
 let direction=null;
 // Default FX point size; crypto/JPY pairs have separate point scales.
 const point=/BTC|ETH/i.test(state.asset)?0.01:/JPY/i.test(state.asset)?0.001:0.00001;
 if(last.close>=upper&&last.close-upper<=point&&rsi>=77&&rsi<=83)direction="PUT";
 if(last.close<=lower&&lower-last.close<=point&&rsi>=18&&rsi<=23)direction="CALL";
 if(!direction)return;
 const id=state.asset+":5:"+last.time+":"+direction;if(id===state.lastSignalId)return;
 state.lastSignalId=id;const signal={id,direction,asset:state.asset,period:5,durationSeconds:15,entryPrice:last.close,rsi,createdAt:Date.now()};
 state.lastSignal=signal;publish("Сигнал "+direction+" · RSI "+rsi.toFixed(1));
 if(state.autoTrading)placeOrder(direction,state.amount,"auto");
}
async function placeOrder(direction,amount,source){
 if(!["CALL","PUT"].includes(direction))return {ok:false,message:"Неизвестное направление."};
 if(!Number.isFinite(amount)||amount<1||amount>50000)return {ok:false,message:"Сумма должна быть от 1 до 50000."};
 if(!state.authenticated||!state.demoVerified||!state.ws||state.ws.readyState!==WebSocket.OPEN)return {ok:false,message:"Сделки доступны только при подключённом и подтверждённом DEMO."};
 if(state.executionUncertain||state.orderPending)return {ok:false,message:"Предыдущий ордер ещё не подтверждён. Повторная отправка заблокирована."};
 state.orderPending=true;state.amount=amount;
 const requestId=Date.now();
 try{
  event("openOrder",{asset:state.asset,amount,action:direction.toLowerCase(),isDemo:1,requestId,optionType:100,time:15});
  orderTimer=setTimeout(()=>{state.orderPending=false;state.executionUncertain=true;state.autoTrading=false;try{event("updateOpenedDeals");}catch{}publish("Нет подтверждения ордера. Проверь историю сделок; повторная отправка заблокирована.");},12000);
  publish((source==="auto"?"Автоордер ":"Ручной ордер ")+direction+" отправлен, ожидаю подтверждение брокера.");
  return {ok:true,message:"Ордер отправлен. Жду подтверждение брокера."};
 }catch(e){state.orderPending=false;state.executionUncertain=true;state.autoTrading=false;publish("Неопределённый результат отправки. Повтор заблокирован.");return {ok:false,message:e.message};}
}
chrome.runtime.onMessage.addListener((m,sender,respond)=>{
 (async()=>{
  if(m.type==="GET_STATE")return snapshot();
  if(m.type==="CONNECT"){try{connect(m.ssid,m.uid,m.asset||"EURUSD_otc");return {ok:true,message:"Подключение запущено. SSID не сохраняется."};}catch(e){return {ok:false,message:e.message};}}
  if(m.type==="MANUAL_TRADE")return placeOrder(m.direction,Number(m.amount),"manual");
  if(m.type==="SET_AUTO"){
   const amount=Number(m.amount);if(!Number.isFinite(amount)||amount<1||amount>50000)return {ok:false,message:"Некорректная сумма."};
   if(m.enabled&&!state.demoVerified)return {ok:false,message:"Автоторговля запрещена: DEMO не подтверждён."};
   state.amount=amount;state.autoTrading=Boolean(m.enabled);publish(state.autoTrading?"Автоторговля включена.":"Автоторговля выключена.");return {ok:true,message:state.status};
  }
  if(m.type==="SET_ASSET"){
   if(!/^[A-Za-z0-9_#]{3,32}$/.test(m.asset||""))return {ok:false,message:"Некорректный символ."};
   state.asset=m.asset;if(state.demoVerified){state.candles=[];state.current=null;state.lastSignalId=null;event("changeSymbol",{asset:state.asset,period:5});event("subfor",state.asset);}
   return {ok:true,message:"Инструмент изменён."};
  }
  return {ok:false,message:"Неизвестная команда."};
 })().then(respond).catch(e=>respond({ok:false,message:e.message}));
 return true;
});
