"use strict";
const $=id=>document.getElementById(id);
const send=message=>chrome.runtime.sendMessage(message);
function log(text){$("log").textContent=new Date().toLocaleTimeString()+" · "+text+"
"+$("log").textContent;}
async function refresh(){
 const s=await send({type:"GET_STATE"});
 if(!s)return;
 $("lamp").classList.toggle("on",s.connected);
 $("account").textContent=s.demoVerified?"DEMO подтверждён":s.authenticated?"Проверяется":"Не проверен";
 $("price").textContent=s.price==null?"—":Number(s.price).toFixed(6);
 $("candles").textContent=s.candleCount||0;
 $("rsi").textContent=s.rsi==null?"—":Number(s.rsi).toFixed(1);
 $("signal").textContent=s.lastSignal? s.lastSignal.direction+" · RSI "+Number(s.lastSignal.rsi).toFixed(1)+" · "+new Date(s.lastSignal.createdAt).toLocaleTimeString():"Ожидание сигнала";
 $("signal").className="signal "+(s.lastSignal?.direction==="CALL"?"call":s.lastSignal?.direction==="PUT"?"put":"");
 $("tradeState").textContent=s.autoTrading?"Автоторговля включена":s.demoVerified?"DEMO подтверждён. Можно торговать.":"Торговля заблокирована до подтверждения DEMO.";
 $("auto").checked=Boolean(s.autoTrading);
 if(s.status)$("log").textContent=s.status;
}
$("connect").addEventListener("click",async()=>{
 const authMessage=$("authMessage").value.trim();
 if(!authMessage){log("Вставь полное auth-сообщение.");return;}
 $("connect").disabled=true;
 try{const r=await send({type:"CONNECT",authMessage,asset:$("asset").value.trim()});log(r?.message||"Запрос подключения отправлен.");}
 catch(e){log("Ошибка: "+e.message);}
 $("connect").disabled=false;refresh();
});
$("call").addEventListener("click",async()=>{const r=await send({type:"MANUAL_TRADE",direction:"CALL",amount:Number($("amount").value)});log(r?.message||"CALL отправлен.");refresh();});
$("put").addEventListener("click",async()=>{const r=await send({type:"MANUAL_TRADE",direction:"PUT",amount:Number($("amount").value)});log(r?.message||"PUT отправлен.");refresh();});
$("auto").addEventListener("change",async e=>{const r=await send({type:"SET_AUTO",enabled:e.target.checked,amount:Number($("amount").value)});log(r?.message||"Настройка обновлена.");refresh();});
$("asset").addEventListener("change",async()=>{const r=await send({type:"SET_ASSET",asset:$("asset").value.trim()});log(r?.message||"Инструмент обновлён.");});
chrome.runtime.onMessage.addListener(m=>{if(m.type==="STATE")refresh();if(m.type==="LOG")log(m.message);});
refresh();setInterval(refresh,1200);
