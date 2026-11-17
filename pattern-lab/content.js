// Deliberately read-only bridge. No broker order endpoints or click automation.
(() => {
  const KEY="pocketPatternLab";
  const send=(type,data={})=>window.postMessage({source:"POCKET_PATTERN_LAB",type,...data},"*");
  // The live Pocket Option protocol adapter is intentionally not guessed here.
  // This content script reports page availability and waits for a verified candle adapter.
  send("PAGE_READY",{url:location.href});
  window.addEventListener("message",event=>{
    if(event.source!==window||event.data?.source!=="POCKET_PATTERN_LAB_UI")return;
    if(event.data.type==="GET_STATUS")send("STATUS",{connected:false,reason:"Источник свечей ещё не подключён; импортируйте CSV для анализа."});
  });
  chrome.runtime.onMessage?.addListener((msg,_sender,reply)=>{
    if(msg?.type==="PATTERN_LAB_STATUS"){reply({ok:true,connected:false,mode:"research-only"});}
  });
})();