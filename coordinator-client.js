"use strict";
/* Per-tab micro-client. No scanning, network data polling, or DOM observers. */
(()=>{
  if(globalThis.CGS_COORDINATOR_CLIENT)return;
  globalThis.CGS_COORDINATOR_CLIENT=true;
  let epoch=-1,active=false;
  globalThis.CGS_COORDINATOR_ACTIVE=false;
  function apply(enabled,ticket){
    const n=Number(ticket);
    if(!Number.isInteger(n)||n<epoch)return;
    const next=!!enabled && !document.hidden;
    if(n===epoch && next===active)return;
    const changed=next!==active;
    epoch=n;active=next;
    globalThis.CGS_COORDINATOR_ACTIVE=active;
    // New epoch with the same ownership is not a real activation.
    if(!changed)return;
    document.dispatchEvent(new CustomEvent("cgs:coordinator-active",{
      detail:{active,epoch}
    }));
  }
  browser.runtime.onMessage.addListener(msg=>{
    if(msg?.type!=="SUP_COORD_SET_ACTIVE")return undefined;
    apply(msg.active,msg.epoch);
    return Promise.resolve({ok:true,active});
  });
  function register(){
    if(document.hidden){apply(false,Math.max(0,epoch));return;}
    browser.runtime.sendMessage({type:"SUP_COORD_REGISTER"})
      .then(response=>{
        if(response?.ok)apply(response.active,response.epoch);
        else apply(false,Math.max(0,epoch));
      }).catch(()=>apply(false,Math.max(0,epoch)));
  }
  document.addEventListener("visibilitychange",()=>{
    if(document.hidden)apply(false,Math.max(0,epoch));
    else register();
  });
  // Initial registration already runs below. Only BFCache restores need pageshow.
  window.addEventListener("pageshow",event=>{
    if(event.persisted)register();
  });
  register();
})();
