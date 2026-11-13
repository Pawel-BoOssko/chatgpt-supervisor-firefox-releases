"use strict";
const BASE = "http://127.0.0.1:19431";
let cache = null;
let fetchedAt = 0;
let inflight = null;

async function load(force = false) {
  if (!force && cache && Date.now()-fetchedAt < 10000) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(()=>controller.abort(),5000);
    try {
      const res = await fetch(BASE+"/api/status",{signal:controller.signal,cache:"no-store"});
      if (!res.ok) throw new Error("HTTP "+res.status);
      const data = await res.json();
      if (!data || data.ok!==true || !data.states || typeof data.states!=="object")
        throw new Error("Niepoprawna odpowiedź mostka Nadzoru");
      cache = {...data,connected:true};
      fetchedAt = Date.now();
      return cache;
    } catch(e) {
      if (cache) return {...cache,connected:false,error:String(e.message||e)};
      return {ok:false,connected:false,states:{},error:String(e.message||e)};
    } finally {
      clearTimeout(timeout);
      inflight = null;
    }
  })();
  return inflight;
}

async function leave(uuid) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(uuid||""))
    return {ok:false,error:"Nieprawidłowy UUID rozmowy"};
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(),8000);
  try {
    const response = await fetch(BASE+"/api/leave",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({uuid:uuid.toLowerCase()}),
      signal:controller.signal,
      cache:"no-store"
    });
    const result = await response.json();
    if(!response.ok || !result.ok)
      throw new Error(result.error || "HTTP "+response.status);
    cache=null;
    fetchedAt=0;
    return result;
  } catch(e) {return {ok:false,error:String(e.message||e)};}
  finally {clearTimeout(timeout);}
}

browser.runtime.onMessage.addListener(message=>{
  if(message && message.type==="SUP_STATUS_GET") return load(!!message.force);
  if(message && message.type==="SUP_LEAVE") return leave(message.uuid);
  return undefined;
});