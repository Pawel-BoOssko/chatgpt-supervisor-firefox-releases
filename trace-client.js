"use strict";
/* Diagnostic observability only. Does not read full chat bodies, identify
   chats beyond the current UI, merge identities or change Imeno.
   Browser content and background share this facade, never raw credentials. */
globalThis.CGS_TRACE=(()=>{
  const isPage=location.hostname==="chatgpt.com";
  const UUID=/\/c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\/|$)/i;
  const session="supervisor-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,9);
  const pageId=isPage?"page-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,8):null;
  let seq=0;
  const routeToId=route=>/^S(?:0\d|1\d|2[0-2])$/.test(route)?route:"S21";
  function id(){return session+"-"+(++seq).toString(36);}
  function record(route,event,attrs={}){
    const clean={schema_version:1,event,route_id:routeToId(route),
      timestamp_utc:new Date().toISOString(),
      trace_id:attrs.trace_id||id(),
      page_id:pageId||undefined,
      ...attrs};
    if(isPage){
      const match=UUID.exec(location.pathname);
      clean.chat_uuid=clean.chat_uuid||match?.[1]?.toLowerCase();
      clean.chat_url=clean.chat_url||location.origin+location.pathname;
      // Never store full document text or message bodies.
      clean.chat_title=(clean.chat_title||
        document.title.replace(/\s*[-–|]\s*ChatGPT\s*$/i,"").trim()).slice(0,240);
    }
    return clean;
  }
  function emit(route,event,attrs={}){
    try{
      const r=record(route,event,attrs);
      if(isPage){
        // A disconnected or disabled background cannot be a false success.
        void browser.runtime.sendMessage({type:"SUP_TRACE",trace:r}).catch(()=>{});
      }else if(typeof globalThis.CGS_TRACE_SINK==="function"){
        globalThis.CGS_TRACE_SINK(r);
      }
      return r.trace_id;
    }catch(_){return null;}
  }
  if(!isPage){
    const DEST="http://127.0.0.1:19431/api/trace";
    const QUEUE_KEY="cgs_diagnostic_telemetry_pending_v1";
    const INSTANCE_KEY="cgs_diagnostic_telemetry_instance_v1";
    let queue=[],timer=null,busy=false,blockedUntil=0,instance=null,ready=false;
    let dropped=0;
    async function boot(){
      try{
        const values=await browser.storage.local.get([QUEUE_KEY,INSTANCE_KEY]);
        instance=typeof values[INSTANCE_KEY]==="string"?values[INSTANCE_KEY]:
           "fx-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,9);
        const prior=Array.isArray(values[QUEUE_KEY])?values[QUEUE_KEY]:[];
        queue=[...prior.slice(-250),...queue].slice(-350);
        await browser.storage.local.set({[INSTANCE_KEY]:instance});
      }catch(_){
        instance="fx-"+Date.now().toString(36);
      }
      ready=true;
      emit("S00","EXTENSION_START",{phase:"background",
        build:browser.runtime.getManifest?.().version||"unknown",
        safe_values:{source:"firefox_background"}});
      schedule();
    }
    function append(r){
      queue.push(r);
      if(queue.length>350){dropped+=queue.length-350;queue=queue.slice(-350);}
      if(ready)schedule();
    }
    function schedule(){
      if(timer||busy||!queue.length)return;
      const delay=Math.max(550,blockedUntil-Date.now());
      timer=setTimeout(()=>{timer=null;void flush();},delay);
    }
    async function flush(){
      if(busy||!queue.length)return;
      busy=true;
      const batch=queue.splice(0,Math.min(queue.length,45));
      if(dropped){
        batch.push(record("S21","LOG_DROPPED",{skipped_count:dropped,
          reason_code:"bounded_memory_queue"}));
        dropped=0;
      }
      for(const row of batch){
        row.browser_instance_id=instance||"unavailable";
      }
      try{
        const controller=new AbortController();
        const timeout=setTimeout(()=>controller.abort(),6500);
        let res;
        try{
          res=await fetch(DEST,{method:"POST",
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({events:batch}),cache:"no-store",
            signal:controller.signal
          });
        }finally{clearTimeout(timeout);}
        if(!res.ok)throw new Error("log_http_"+res.status);
        const reply=await res.json();
        if(reply?.ok!==true||reply.recorded!==batch.length)
          throw new Error("log_no_confirmation");
        blockedUntil=0;
        // Do not replace newly queued data (which may include another trace).
        await browser.storage.local.set({[QUEUE_KEY]:queue.slice(-250)});
      }catch(_){
        queue=[...batch.filter(e=>e.event!=="LOG_DROPPED"),...queue].slice(-350);
        blockedUntil=Date.now()+30000;
        try{await browser.storage.local.set({[QUEUE_KEY]:queue.slice(-250)});}catch(__){}
      }finally{busy=false;schedule();}
    }
    globalThis.CGS_TRACE_SINK=append;
    void boot();
  }
  return {emit,record,newId:id,pageId,session};
})();
