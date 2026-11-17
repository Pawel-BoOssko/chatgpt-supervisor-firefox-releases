"use strict";
// ChatGPT Supervisor Status v0.4.0 - author GPT-6, 2026-11-14 CET.
// The background service worker is the only browser code touching localhost.
// The secret authorizing central Imeno API is held solely by the Python bridge.
const BASE = "http://127.0.0.1:19431";
let statusCache = null;
let statusFetchedAt = 0;
let statusInflight = null;
const profiles = new Map();
let profilesInflight = null;

async function jsonRequest(path, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, {
      cache: "no-store", ...options,
      signal: controller.signal,
    });
    const data = await res.json();
    if (!res.ok || data.ok === false){
      const error=new Error((data && (data.error||data.status)) || "HTTP "+res.status);
      error.http_status=res.status;
      error.payload=data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function rememberStatusError(error){
  const event={at:new Date().toISOString(),error:String(error||"unknown").slice(0,320)};
  console.warn("ChatGPT Supervisor Status: błąd odczytu Nadzoru",event.error);
  try{
    const data=await browser.storage.local.get("cgs_status_errors");
    const old=Array.isArray(data.cgs_status_errors)?data.cgs_status_errors:[];
    await browser.storage.local.set({
      cgs_status_errors:[...old.slice(-39),event]
    });
  }catch(_){}
}
async function getStatus(force = false) {
  if (!force && statusCache && Date.now() - statusFetchedAt < 300000)
    return statusCache;
  if (statusInflight) return statusInflight;
  statusInflight = (async () => {
    try {
      const data = await jsonRequest("/api/status", {}, 12000);
      if (!data.states || typeof data.states !== "object")
        throw new Error("Niepoprawna odpowiedź Nadzoru");
      statusCache = {...data, connected: true};
      statusFetchedAt = Date.now();
      return statusCache;
    } catch (e) {
      await rememberStatusError(e.message||e);
      if (statusCache) return {...statusCache, connected: false,
                              error: String(e.message || e)};
      return {ok: false, connected: false, states: {},
              error: String(e.message || e)};
    } finally {
      statusInflight = null;
    }
  })();
  return statusInflight;
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
async function getProfiles(uuids, force = false) {
  if (!Array.isArray(uuids)) return {ok:false, error:"uuid_list_expected"};
  const ids = [...new Set(uuids.filter(x => typeof x==="string" && UUID.test(x))
                            .map(x => x.toLowerCase()))].slice(0,200);
  if (!ids.length) return {ok:true, items:[]};
  const age = Date.now();
  const missing = ids.filter(id => force || !profiles.has(id) ||
                                  age - profiles.get(id).at > 1800000);
  if (missing.length) {
    if (profilesInflight) await profilesInflight;
    else {
      profilesInflight = (async () => {
        try {
          const data = await jsonRequest("/api/profile/resolve",{
            method:"POST", headers:{"Content-Type":"application/json"},
            body:JSON.stringify({uuids: missing})
          }, 9000);
          if (!Array.isArray(data.items)) throw new Error("profile_items_missing");
          for (const item of data.items) {
            if (UUID.test(item.uuid)) {
              profiles.set(item.uuid.toLowerCase(),{at:Date.now(),item});
            }
          }
          return null;
        } catch(e) {
          return String(e.message || e);
        } finally {
          profilesInflight = null;
        }
      })();
      const error = await profilesInflight;
      if (error) return {ok:false, error,
                        items:ids.filter(id=>profiles.has(id))
                                 .map(id=>profiles.get(id).item)};
    }
  }
  return {ok:true, items:ids.filter(id=>profiles.has(id))
                         .map(id=>profiles.get(id).item)};
}

async function enqueueWakeRequests(uuids){
  if(!Array.isArray(uuids)||uuids.length<1||uuids.length>100||
     uuids.some(id=>typeof id!=="string"||!UUID.test(id)))
    return {ok:false,error:"Nieprawidłowa lista UUID (1–100)"};
  try{
    return await jsonRequest("/api/wake/request",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({uuids:[...new Set(uuids.map(x=>x.toLowerCase()))]})
    },12000);
  }catch(e){return {ok:false,error:String(e.message||e)};}
}

async function logEvent(message){
  const event={
    event:message.event,action:message.action,detail:message.detail,
    uuids:message.uuids,selected:message.selected,version:message.version
  };
  try{
    return await jsonRequest("/api/event",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify(event)
    },5000);
  }catch(e){return {ok:false,error:String(e.message||e)};}
}

async function saveFeedback(message){
  const note=String(message||"").trim();
  if(note.length<3||note.length>3000)
    return {ok:false,error:"Uwaga musi mieć 3–3000 znaków"};
  try{
    return await jsonRequest("/api/feedback",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({message:note,
        version:browser.runtime.getManifest().version})
    },10000);
  }catch(e){return {ok:false,error:String(e.message||e)};}
}

async function leaveNadzor(uuid) {
  if (!UUID.test(uuid||"")) return {ok:false,error:"Nieprawidłowy UUID"};
  try {
    const data = await jsonRequest("/api/leave",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({uuid:uuid.toLowerCase()})
    },9000);
    statusCache=null;
    return data;
  }catch(e){return {ok:false,error:String(e.message||e)};}
}

async function updateProfile(action) {
  const uuid = action && action.uuid;
  if(!UUID.test(uuid||"")) return {ok:false,error:"Nieprawidłowy UUID"};
  const data={uuid:uuid.toLowerCase(),expected_revision:action.expected_revision};
  if(action.field==="important") data.important=action.important;
  else if(action.field==="imeno") data.imeno=action.imeno;
  else return {ok:false,error:"Nieznane pole"};
  try {
    const result=await jsonRequest("/api/profile/update",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify(data)
    },10000);
    profiles.delete(uuid.toLowerCase());
    statusCache=null;
    return result;
  }catch(e){return {ok:false,error:String(e.message||e)};}
}

async function lifecycleGet(uuids) {
  const ids=[...new Set((uuids||[]).filter(id=>UUID.test(id||"")).map(id=>id.toLowerCase()))];
  if(!ids.length || ids.length>150)return {ok:false,error:"invalid_uuid_list"};
  try {
    return await jsonRequest("/api/lifecycle/status",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({uuids:ids})
    },9000);
  }catch(e){return {ok:false,error:String(e.message||e)};}
}

async function lifecycleUpdate(action) {
  if(!UUID.test(action?.uuid||""))return {ok:false,error:"invalid_uuid"};
  if(!["active","temporary_unavailable","dead_manual","retired"].includes(action?.state))
    return {ok:false,error:"invalid_lifecycle_state"};
  const revision=action?.expected_revision;
  if(!Number.isInteger(revision) || revision<0)return {ok:false,error:"invalid_revision"};
  const data={uuid:action.uuid.toLowerCase(),state:action.state,expected_revision:revision};
  if(action.archive==="requested")data.archive="requested";
  try{
    const result=await jsonRequest("/api/lifecycle/update",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify(data)
    },10000);
    profiles.delete(data.uuid);
    statusCache=null;
    return result;
  }catch(e){return {ok:false,error:String(e.message||e)};}
}

async function observeBrowser(action) {
  const uuid=action && action.uuid;
  if(!UUID.test(uuid||"")) return {ok:false,error:"invalid_uuid"};
  const data={uuid:uuid.toLowerCase()};
  if(typeof action.url==="string" && action.url.length<=2048)
    data.url=action.url;
  if(typeof action.source==="string")
    data.source=action.source;
  if(typeof action.title==="string" && action.title.length<=240)
    data.title=action.title;
  if(typeof action.mcp_nick_declaration==="string" &&
     action.mcp_nick_declaration.length<=60)
    data.mcp_nick_declaration=action.mcp_nick_declaration;
  try {
    return await jsonRequest("/api/browser/observe",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify(data)
    },10000);
  }catch(e){return {ok:false,error:String(e.message||e)};}
}

async function getChatContext(uuid){
  if(!UUID.test(uuid||""))return {ok:false,error:"invalid_uuid"};
  try{
    return await jsonRequest("/api/chat/context?uuid="+encodeURIComponent(uuid.toLowerCase()),{},10000);
  }catch(e){return {ok:false,...(e.payload||{}),
    error:String(e.message||e),http_status:e.http_status||null};}
}

async function triageChat(message){
  if(!UUID.test(message?.uuid||""))return {ok:false,error:"invalid_uuid"};
  if(!["temporary","dead_exclude","dead_handover","dead_close","restore"].includes(message?.action))
    return {ok:false,error:"invalid_action"};
  const payload={uuid:message.uuid.toLowerCase(),action:message.action,
    expected_revision:message.expected_revision,
    folders:message.folders||[],note:message.note||""};
  try{
    const result=await jsonRequest("/api/chat/triage",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify(payload)
    },15000);
    profiles.delete(payload.uuid);statusCache=null;
    return result;
  }catch(e){
    return {ok:false,...(e.payload||{}),error:String(e.message||e),
      http_status:e.http_status||null,
      conflict:e.http_status===409||
        /revision|successor|conflict/i.test(String(e.message||e))};
  }
}

async function openNewChatTab(sender){
  try{
    const options={url:"https://chatgpt.com/",active:true};
    const windowId=sender?.tab?.windowId;
    if(Number.isInteger(windowId) && windowId>=0)options.windowId=windowId;
    const tab=await browser.tabs.create(options);
    if(!tab || !Number.isInteger(tab.id))
      throw new Error("Nowa karta nie została potwierdzona");
    const active=await browser.tabs.query({active:true,windowId:tab.windowId});
    if(!Array.isArray(active)||!active.some(item=>item.id===tab.id))
      throw new Error("Nowa karta nie została aktywowana");
    return {ok:true,tabId:tab.id,windowId:tab.windowId,active:true};
  }catch(e){
    return {ok:false,error:String(e.message||e)};
  }
}
async function openChatTabs(uuids){
  if(!Array.isArray(uuids)||!uuids.length||uuids.length>40)
    return {ok:false,error:"invalid_tab_count"};
  const ids=[...new Set(uuids)];
  if(ids.some(id=>!UUID.test(id||"")))
    return {ok:false,error:"invalid_uuid"};
  let opened=0;const failures=[];
  for(const uuid of ids){
    try{await browser.tabs.create({url:"https://chatgpt.com/c/"+uuid.toLowerCase(),
                                   active:false});opened++;}
    catch(e){failures.push(uuid+": "+String(e.message||e));}
  }
  return {ok:failures.length===0,opened,failures};
}


const UPDATE_MANIFEST="https://raw.githubusercontent.com/"+
  "Pawel-BoOssko/chatgpt-supervisor-firefox-releases/main/updates.json";
const ADDON_ID="chatgpt-supervisor-status@lupus.local";
let updateStatusCache=null,updateStatusAt=0,updateStatusInflight=null;
function compareVersions(a,b){
  const parts=v=>String(v||"").split(".").map(n=>Number(n));
  const left=parts(a),right=parts(b);
  if(left.some(n=>!Number.isInteger(n))||right.some(n=>!Number.isInteger(n)))
    return null;
  for(let i=0;i<Math.max(left.length,right.length);i++){
    const diff=(left[i]||0)-(right[i]||0);
    if(diff)return Math.sign(diff);
  }
  return 0;
}
async function getBuildStatus(force=false){
  const installed=browser.runtime.getManifest().version;
  const build=globalThis.CGS_BUILD_INFO||{};
  if(!force && updateStatusCache && Date.now()-updateStatusAt<900000)
    return updateStatusCache;
  if(updateStatusInflight)return updateStatusInflight;
  updateStatusInflight=(async()=>{
    let result={ok:false,installed,build,latest:null,upToDate:null};
    try{
      const controller=new AbortController();
      const timeout=setTimeout(()=>controller.abort(),7000);
      let response;
      try{response=await fetch(UPDATE_MANIFEST,{
        cache:"no-store",signal:controller.signal
      });}finally{clearTimeout(timeout);}
      if(!response.ok)throw new Error("HTTP "+response.status);
      const data=await response.json();
      const updates=data?.addons?.[ADDON_ID]?.updates;
      if(!Array.isArray(updates)||!updates.length)
        throw new Error("Brak wersji w manifeście aktualizacji");
      const latest=updates.reduce((best,item)=>
        compareVersions(item.version,best)>=0?item.version:best,
        updates[0].version);
      const comparison=compareVersions(installed,latest);
      result={ok:comparison!==null,installed,build,latest,
        upToDate:comparison===null?null:comparison>=0};
    }catch(e){result.error=String(e.message||e);}
    updateStatusCache=result;updateStatusAt=Date.now();
    return result;
  })();
  try{return await updateStatusInflight;}
  finally{updateStatusInflight=null;}
}

// The only durable registry is IMENO. Suppress duplicate browser observations
// across tabs and reloads; do not poll titles or fetch a whole account index.
const SIDEBAR_KNOWN_KEY="cgs_sidebar_observed_uuid_v044";
let sidebarKnownPromise=null,sidebarQueue=Promise.resolve();
function loadSidebarKnown(){
  if(!sidebarKnownPromise){
    sidebarKnownPromise=browser.storage.local.get(SIDEBAR_KNOWN_KEY)
      .then(data=>new Set(Array.isArray(data?.[SIDEBAR_KNOWN_KEY])
        ?data[SIDEBAR_KNOWN_KEY].filter(id=>UUID.test(id)).slice(-20000):[]))
      .catch(()=>new Set());
  }
  return sidebarKnownPromise;
}
async function observeSidebarBatch(message){
  const items=message?.items;
  if(!Array.isArray(items)||items.length<1||items.length>150)
    return {ok:false,error:"invalid_sidebar_batch"};
  if(items.some(item=>!item||typeof item!=="object"||
      !UUID.test(item.uuid||"")||item.source!=="sidebar_dom"))
    return {ok:false,error:"invalid_sidebar_item"};
  const known=await loadSidebarKnown();
  const unique=new Map();
  for(const item of items){
    const id=item.uuid.toLowerCase();
    if(known.has(id)||unique.has(id))continue;
    const record={uuid:id,source:"sidebar_dom"};
    if(typeof item.title==="string"&&item.title.trim())
      record.title=item.title.trim().slice(0,240);
    if(typeof item.url==="string")record.url=item.url;
    unique.set(id,record);
  }
  if(!unique.size)return {ok:true,observed:0,skipped:true};
  try{
    const result=await jsonRequest("/api/browser/observe-batch",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({items:[...unique.values()]})
    },15000);
    if(result?.ok!==true)return result;
    for(const id of unique.keys())known.add(id);
    // Bounded persistent cache only. IMENO remains authoritative, and
    // this is NOT a shadow database of conversation titles or content.
    await browser.storage.local.set({
      [SIDEBAR_KNOWN_KEY]:[...known].slice(-20000)
    });
    return {ok:true,observed:result.observed||unique.size};
  }catch(e){return {ok:false,error:String(e.message||e)};}
}
function enqueueSidebarBatch(message){
  const work=()=>observeSidebarBatch(message);
  const next=sidebarQueue.then(work,work);
  sidebarQueue=next.catch(()=>{});
  return next;
}

browser.runtime.onMessage.addListener((message,sender)=>{
  if(message && message.type==="SUP_COORD_REGISTER")
    return globalThis.CGS_COORDINATOR?.register(sender)
      ||Promise.resolve({ok:false,active:false});
  if(message && message.type==="SUP_COORD_STATUS")
    return Promise.resolve({ok:true,ownerTabId:globalThis.CGS_COORDINATOR?.getOwner(),
      epoch:globalThis.CGS_COORDINATOR?.getEpoch()});
  if(message && message.type==="SUP_BUILD_STATUS")
    return getBuildStatus(!!message.force);
  if(message && message.type==="SUP_STATUS_GET")
    return getStatus(!!message.force);
  if(message && message.type==="SUP_PROFILE_GET")
    return getProfiles(message.uuids,!!message.force);
  if(message && message.type==="SUP_PROFILE_UPDATE")
    return updateProfile(message);
  if(message && message.type==="SUP_CONTEXT_GET")
    return getChatContext(message.uuid);
  if(message && message.type==="SUP_TRIAGE")
    return triageChat(message);
  if(message && message.type==="SUP_LIFECYCLE_GET")
    return lifecycleGet(message.uuids);
  if(message && message.type==="SUP_LIFECYCLE_UPDATE")
    return lifecycleUpdate(message);
  if(message && message.type==="SUP_BROWSER_OBSERVE_BATCH")
    return enqueueSidebarBatch(message);
  if(message && message.type==="SUP_BROWSER_OBSERVE")
    return observeBrowser(message);
  if(message && message.type==="SUP_OPEN_TABS")
    return openChatTabs(message.uuids);
  if(message && message.type==="SUP_NEW_CHAT_TAB")
    return openNewChatTab(sender);
  if(message && message.type==="SUP_FEEDBACK")
    return saveFeedback(message.message);
  if(message && message.type==="SUP_LOG_EVENT")
    return logEvent(message);
  if(message && message.type==="SUP_WAKE_REQUEST")
    return enqueueWakeRequests(message.uuids);
  if(message && message.type==="SUP_LEAVE")
    return leaveNadzor(message.uuid);
  return undefined;
});
