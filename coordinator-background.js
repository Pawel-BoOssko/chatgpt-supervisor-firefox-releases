"use strict";
/* One elected owner in the entire Firefox profile. No polling or timers. */
globalThis.CGS_COORDINATOR=(()=>{
  let owner=null,epoch=0;
  const isChat=t=>t && Number.isInteger(t.id) &&
    /^https:\/\/chatgpt\.com(?:\/|$)/i.test(t.url||"") && !t.discarded;
  async function elected(){
    const win=await browser.windows.getLastFocused({populate:false});
    if(!win || !win.focused || !Number.isInteger(win.id))return null;
    const tabs=await browser.tabs.query({active:true,windowId:win.id});
    const found=Array.isArray(tabs)?tabs.find(isChat):null;
    return found?found.id:null;
  }
  async function notify(tab,enabled,ticket){
    if(!Number.isInteger(tab))return;
    try{await browser.tabs.sendMessage(tab,{
      type:"SUP_COORD_SET_ACTIVE",active:enabled,epoch:ticket
    });}catch(_){ /* A loading/discarded tab has no listener yet. */ }
  }
  async function reconcile(){
    const ticket=++epoch;
    let chosen=null;
    try{chosen=await elected();}catch(_){}
    if(ticket!==epoch)return {owner,epoch};
    const previous=owner;
    owner=chosen;
    if(previous!==owner){
      if(previous!==null)void notify(previous,false,ticket);
      if(owner!==null)void notify(owner,true,ticket);
    }
    return {owner,epoch:ticket};
  }
  async function register(sender){
    const tab=sender?.tab?.id;
    if(!Number.isInteger(tab))return {ok:false,active:false,epoch};
    await reconcile();
    // Concurrent registrations can supersede our ticket. Return the *latest*
    // authoritative state, never an obsolete owner with the latest epoch.
    return {ok:true,active:owner===tab,
      epoch,ownerTabId:owner};
  }
  browser.tabs.onActivated.addListener(()=>{void reconcile();});
  browser.tabs.onUpdated.addListener((_id,change,tab)=>{
    if(tab.active&&(change.url || change.status==="complete"))void reconcile();
  });
  browser.tabs.onRemoved.addListener(id=>{if(id===owner){owner=null;void reconcile();}});
  browser.windows.onFocusChanged.addListener(()=>{void reconcile();});
  browser.windows.onRemoved.addListener(()=>{void reconcile();});
  void reconcile();
  return {register,reconcile,getOwner:()=>owner,getEpoch:()=>epoch};
})();
