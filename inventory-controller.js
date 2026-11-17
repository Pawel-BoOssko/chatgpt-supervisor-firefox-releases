"use strict";
/* Event-driven inventory coordinator: one foreground ChatGPT tab per browser
 * profile, at most one attempted inventory every 15 minutes, normally due
 * only after 6 hours. No timers repeating every few seconds or minutes. */
(()=>{
  if(globalThis.CGS_INVENTORY_CONTROL)return;
  const isActive=()=>!document.hidden&&globalThis.CGS_COORDINATOR_ACTIVE!==false;
  const create=globalThis.CGSCreateInventoryScanner;
  if(typeof create!=="function")return;
  const scanner=create({
    fetchFn:window.fetch.bind(window),
    sendFn:msg=>browser.runtime.sendMessage(msg),
    isActive,
    onResult:result=>document.dispatchEvent(new CustomEvent("cgs:inventory-result",{
      detail:result
    }))
  });
  let timer=null,lastAttemptAt=0;
  const MIN_RETRY_MS=15*60*1000;
  function cancelTimer(){
    if(timer!==null){clearTimeout(timer);timer=null;}
  }
  function scheduleCheck(delayMs=10000){
    if(!isActive()||scanner.snapshot().running)return;
    if(Date.now()-lastAttemptAt<MIN_RETRY_MS)return;
    cancelTimer();
    timer=setTimeout(async()=>{
      timer=null;
      if(!isActive()||scanner.snapshot().running)return;
      lastAttemptAt=Date.now();
      const result=await scanner.run();
      document.dispatchEvent(new CustomEvent("cgs:inventory-check",{
        detail:result
      }));
    },delayMs);
  }
  function onOwnerChange(){
    if(isActive())scheduleCheck();
    else{cancelTimer();void scanner.pause();}
  }
  document.addEventListener("cgs:coordinator-active",onOwnerChange);
  document.addEventListener("visibilitychange",onOwnerChange);
  browser.runtime.onMessage.addListener(message=>{
    if(message?.type!=="SUP_INVENTORY_CHECK")return undefined;
    scheduleCheck();
    return Promise.resolve({ok:true});
  });
  globalThis.CGS_INVENTORY_CONTROL={
    runNow:async()=>{
      if(!isActive())return {ok:false,error:"inactive_tab"};
      cancelTimer();
      if(scanner.snapshot().running)return {ok:false,error:"scan_already_running"};
      lastAttemptAt=Date.now();
      const result=await scanner.run({force:true});
      document.dispatchEvent(new CustomEvent("cgs:inventory-check",{detail:result}));
      return result;
    },
    snapshot:scanner.snapshot
  };
  onOwnerChange();
})();
