/* Pocket Tracker local-only service worker. No API calls or telemetry. */
'use strict';
const PO_URLS=['https://pocketoption.com/*','https://*.pocketoption.com/*'];
async function focusPocketOption(){
  const tabs=await chrome.tabs.query({url:PO_URLS});
  if(tabs.length){
    const tab=tabs.find(t=>t.active)||tabs[0];
    await chrome.tabs.update(tab.id,{active:true});
    await chrome.windows.update(tab.windowId,{focused:true});
  }else{
    await chrome.tabs.create({url:'https://pocketoption.com/ru/cabinet/demo-quick-high-low/'});
  }
}
chrome.runtime.onInstalled.addListener(async details=>{
  if(details.reason!=='install')return;
  const saved=await chrome.storage.local.get(['analysisTimeframe','autoTrade']);
  const defaults={};
  if(saved.analysisTimeframe==null)defaults.analysisTimeframe=5;
  if(saved.autoTrade==null)defaults.autoTrade=false;
  await chrome.storage.local.set(defaults);
});
chrome.action.onClicked.addListener(()=>focusPocketOption().catch(e=>console.error('[Pocket Tracker]',e)));
chrome.runtime.onMessage.addListener((req,sender,sendResponse)=>{
  if(!req||typeof req!=='object')return false;
  if(req.action==='getSettings'){
    chrome.storage.local.get(null).then(sendResponse);
    return true;
  }
  if(['POROBOT_CORE_CMD','POROBOT_START','POROBOT_STOP','BOT_FOCUS_PAIR'].includes(req.type)){
    const tabId=req.tabId||(sender.tab&&sender.tab.id);
    if(Number.isInteger(tabId))chrome.tabs.sendMessage(tabId,req).catch(()=>{});
  }
  return false;
});
