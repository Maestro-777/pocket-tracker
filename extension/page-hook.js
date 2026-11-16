"use strict";

/* Read-only diagnostics hook. Never forwards auth payloads or raw frames. */
(() => {
  if (window.__PT_PAGE_HOOK_INSTALLED__) return;
  Object.defineProperty(window, "__PT_PAGE_HOOK_INSTALLED__", { value: true });
  const NativeWebSocket = window.WebSocket;
  const allowedEvents = new Set(["successauth","loadHistoryPeriodFast","updateStream","updateAssets"]);
  const stats = { installed:true, socketsCreated:0, socketsOpened:0, socketsClosed:0, socketErrors:0,
    incomingFrames:0, outgoingFrames:0, incomingEvents:[], outgoingEvents:[], lastDirection:"",
    lastEvent:"", lastAt:0, socketHost:"", socketPath:"", readyState:"none" };
  function safeUrl(value) {
    try { const u = new URL(String(value), location.href); return { host:u.hostname, path:u.pathname.slice(0,120) }; }
    catch (_) { return {host:"",path:""}; }
  }
  function emit(type, payload) {
    try { window.postMessage({source:"pt-pocketoption-page-hook",type,payload},location.origin); } catch (_) {}
  }
  function diagnostic(extra={}) { emit("diagnostic",{...stats,...extra,at:Date.now()}); }
  function remember(list,name) { if (!name) return; list.push(name); if(list.length>8) list.shift(); }
  function parseSocketFrame(raw,incoming) {
    if (typeof raw !== "string") return;
    if (!raw.startsWith("42")) return;
    let parsed; try { parsed=JSON.parse(raw.slice(2)); } catch (_) { return; }
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string") return;
    const name=parsed[0], data=parsed.length>1?parsed[1]:null, now=Date.now();
    if(incoming) { stats.incomingFrames++; remember(stats.incomingEvents,name); }
    else { stats.outgoingFrames++; remember(stats.outgoingEvents,name); }
    stats.lastDirection=incoming?"IN":"OUT"; stats.lastEvent=name; stats.lastAt=now;
    diagnostic();
    if(!incoming && name==="auth" && data && typeof data==="object") {
      const flag=data.isDemo;
      const isDemo=flag===1 || flag===true || String(flag).toLowerCase()==="true";
      emit("account",{isDemo,detectedAt:now}); return;
    }
    if(incoming && allowedEvents.has(name)) {
      if(name==="successauth") emit("broker-auth",{authenticated:true,at:now});
      else emit("market-event",{name,data,at:now});
    }
  }
  function WrappedWebSocket(...args) {
    const socket=new NativeWebSocket(...args);
    stats.socketsCreated++;
    const safe=safeUrl(args[0]); stats.socketHost=safe.host; stats.socketPath=safe.path;
    stats.readyState="connecting"; diagnostic();
    socket.addEventListener("open",()=>{stats.socketsOpened++;stats.readyState="open";diagnostic();});
    socket.addEventListener("close",()=>{stats.socketsClosed++;stats.readyState="closed";diagnostic();});
    socket.addEventListener("error",()=>{stats.socketErrors++;stats.readyState="error";diagnostic();});
    socket.addEventListener("message",event=>parseSocketFrame(event.data,true));
    const originalSend=socket.send;
    socket.send=function(data){parseSocketFrame(data,false);return originalSend.call(this,data);};
    return socket;
  }
  WrappedWebSocket.prototype=NativeWebSocket.prototype;
  Object.setPrototypeOf(WrappedWebSocket,NativeWebSocket);
  for(const key of ["CONNECTING","OPEN","CLOSING","CLOSED"])
    Object.defineProperty(WrappedWebSocket,key,{value:NativeWebSocket[key]});
  try { window.WebSocket=WrappedWebSocket; } catch (_) {}
  diagnostic();
})();