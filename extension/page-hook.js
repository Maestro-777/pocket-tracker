"use strict";

/* Read-only diagnostics hook. Never forwards auth payloads or raw frames. */
(() => {
  if (window.__PT_PAGE_HOOK_INSTALLED__) return;
  Object.defineProperty(window, "__PT_PAGE_HOOK_INSTALLED__", { value: true });
  const NativeWebSocket = window.WebSocket;
  const allowedEvents = new Set(["successauth","loadHistoryPeriodFast","updateStream","updateAssets"]);
  const stats = { installed:true, socketsCreated:0, socketsOpened:0, socketsClosed:0, socketErrors:0,
    incomingFrames:0, outgoingFrames:0, incomingPackets:0, outgoingPackets:0, incomingTypes:[], outgoingTypes:[], lastPacketType:"", lastPacketBytes:0, lastDirection:"",
    lastEvent:"", lastAt:0, socketHost:"", socketPath:"", readyState:"none", sockets:[] };
  function safeUrl(value) {
    try { const u = new URL(String(value), location.href); return { host:u.hostname, path:u.pathname.slice(0,120) }; }
    catch (_) { return {host:"",path:""}; }
  }
  function emit(type, payload) {
    try { window.postMessage({source:"pt-pocketoption-page-hook",type,payload},location.origin); } catch (_) {}
  }
  function diagnostic(extra={}) { emit("diagnostic",{...stats,sockets:stats.sockets.map(s=>({...s})),...extra,at:Date.now()}); }
  function remember(list,name) { if (!name) return; list.push(name); if(list.length>8) list.shift(); }
  function packetInfo(value) {
    let kind="other", prefix="", bytes=0, textValue=null;
    if(typeof value==="string") { kind="text"; prefix=value.slice(0,3).replace(/[^0-9A-Za-z]/g,"?"); bytes=value.length; textValue=value; }
    else if(value instanceof ArrayBuffer) { kind="arraybuffer"; bytes=value.byteLength; try{textValue=new TextDecoder().decode(value);prefix=textValue.slice(0,3).replace(/[^0-9A-Za-z]/g,"?");}catch(_){} }
    else if(ArrayBuffer.isView(value)) { kind="typedarray"; bytes=value.byteLength; try{textValue=new TextDecoder().decode(value);prefix=textValue.slice(0,3).replace(/[^0-9A-Za-z]/g,"?");}catch(_){} }
    else if(typeof Blob!=="undefined" && value instanceof Blob) { kind="blob"; bytes=value.size; }
    return {kind,prefix,bytes,textValue};
  }
  function notePacket(info,incoming,socketInfo) {
    if(incoming) { stats.incomingPackets++; remember(stats.incomingTypes,info.kind+":"+info.prefix); }
    else { stats.outgoingPackets++; remember(stats.outgoingTypes,info.kind+":"+info.prefix); }
    stats.lastPacketType=info.kind+":"+info.prefix; stats.lastPacketBytes=info.bytes;
    if(socketInfo) {
      if(incoming) { socketInfo.inPackets++; socketInfo.lastInType=stats.lastPacketType; socketInfo.lastInBytes=info.bytes; }
      else { socketInfo.outPackets++; socketInfo.lastOutType=stats.lastPacketType; socketInfo.lastOutBytes=info.bytes; }
    }
    diagnostic();
  }
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
    const safe=safeUrl(args[0]);
    const info={id:stats.socketsCreated,host:safe.host,path:safe.path,state:"connecting",in:0,out:0,inPackets:0,outPackets:0,lastIn:"",lastOut:"",lastInType:"",lastOutType:"",lastInBytes:0,lastOutBytes:0};
    stats.sockets.push(info); if(stats.sockets.length>12) stats.sockets.shift();
    stats.socketHost=safe.host; stats.socketPath=safe.path; stats.readyState="connecting"; diagnostic();
    socket.addEventListener("open",()=>{stats.socketsOpened++;info.state="open";stats.readyState="open";diagnostic();});
    socket.addEventListener("close",()=>{stats.socketsClosed++;info.state="closed";stats.readyState="closed";diagnostic();});
    socket.addEventListener("error",()=>{stats.socketErrors++;info.state="error";diagnostic();});
    socket.addEventListener("message",event=>{
      const value=event.data, packet=packetInfo(value); notePacket(packet,true,info);
      const processText=txt=>{const before=stats.incomingFrames;parseSocketFrame(txt,true);if(stats.incomingFrames>before){info.in++;info.lastIn=stats.lastEvent;diagnostic();}};
      if(packet.textValue!==null) processText(packet.textValue);
      else if(typeof Blob!=="undefined" && value instanceof Blob) value.text().then(processText).catch(()=>{});
    });
    const originalSend=socket.send;
    socket.send=function(data){const packet=packetInfo(data);notePacket(packet,false,info);const before=stats.outgoingFrames;
      if(packet.textValue!==null) parseSocketFrame(packet.textValue,false);
      if(stats.outgoingFrames>before){info.out++;info.lastOut=stats.lastEvent;diagnostic();}
      return originalSend.call(this,data);};
    return socket;
  }
  WrappedWebSocket.prototype=NativeWebSocket.prototype;
  Object.setPrototypeOf(WrappedWebSocket,NativeWebSocket);
  for(const key of ["CONNECTING","OPEN","CLOSING","CLOSED"])
    Object.defineProperty(WrappedWebSocket,key,{value:NativeWebSocket[key]});
  try { window.WebSocket=WrappedWebSocket; } catch (_) {}
  diagnostic();
})();