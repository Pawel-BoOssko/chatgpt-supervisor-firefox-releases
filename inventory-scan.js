"use strict";
/* ChatGPT conversation inventory: full-page, account-scoped, event-triggered.
 * Never treats the first 180 sidebar links as a complete inventory.
 * One 6h scan is scheduled by the background; this scanner has no poll timer.
 */
(function(root){
  function createInventoryScanner({
      fetchFn,sendFn,isActive=()=>true,onResult=()=>{},
      delayMs=200,maxRequests=500
    }={}){
    if(typeof fetchFn!=="function"||typeof sendFn!=="function")
      throw new Error("inventory requires fetch and send functions");
    let running=false,abort=null,attempts=0,lastError="";
    const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
    const PROJECT=/^g-p-[\w-]+$/i;
    function snapshot(){return {running,attempts,lastError};}
    function check(signal){
      if(signal.aborted||!isActive())throw new Error("paused_inactive_tab");
    }
    async function pause(){
      if(abort)abort.abort();
    }
    async function accountHash(user){
      const id=String(user?.id||user?.user_id||"").trim();
      if(!id||id.length>256)throw new Error("MISSING_ACCOUNT_ID");
      const bytes=new TextEncoder().encode("cgs-chat-inventory:"+id);
      const digest=await crypto.subtle.digest("SHA-256",bytes);
      return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");
    }
    async function run({force=false}={}){
      if(running||!isActive())return {...snapshot(),skipped:true};
      running=true;attempts++;lastError="";
      const controller=new AbortController();
      abort=controller;
      let scanId=null,accountKey=null,started=false;
      try{
        const status=await sendFn({type:"SUP_INVENTORY_STATUS"});
        check(controller.signal);
        if(!force&&status?.ok&&!status.due)
          return {ok:true,skipped:true,due:false,last_completed_at:status.last_completed_at};
        let auth=await fetchFn("/api/auth/session",{
          credentials:"include",cache:"no-store",signal:controller.signal});
        if(!auth.ok)throw new Error("SESSION_HTTP_"+auth.status);
        const session=await auth.json();
        const token=String(session?.accessToken||"");
        if(!token)throw new Error("MISSING_SESSION_TOKEN");
        accountKey=await accountHash(session.user);
        check(controller.signal);
        const scoped=await sendFn({type:"SUP_INVENTORY_STATUS",account_key:accountKey});
        if(!force&&scoped?.ok&&!scoped.due)
          return {ok:true,skipped:true,due:false,last_completed_at:scoped.last_completed_at};
        const found=new Map(),projects=new Map();
        let requestCount=0;
        const seenGlobal=new Set();
        async function sleep(ms){
          if(ms<=0)return;
          await new Promise(resolve=>setTimeout(resolve,ms));
          check(controller.signal);
        }
        function add(row,project=""){
          if(row?.is_archived===true)return;
          const uuid=String(row?.uuid||row?.id||"").toLowerCase();
          if(!UUID.test(uuid))return;
          const previous=found.get(uuid);
          const title=String(row?.title||"").trim().slice(0,240);
          const timestamp=Number(row?.update_time||row?.updated||0);
          const updated=Number.isFinite(timestamp)&&timestamp>=0 ? timestamp : 0;
          found.set(uuid,{
            uuid,title:title||previous?.title||"",
            project:String(project||previous?.project||"").slice(0,120),
            updated:Math.max(updated,previous?.updated||0)
          });
        }
        async function api(path){
          check(controller.signal);
          if(!path.startsWith("/backend-api/"))
            throw new Error("INVALID_API_PATH");
          if(requestCount>=maxRequests)throw new Error("INVENTORY_REQUEST_CAP");
          if(requestCount++)await sleep(delayMs);
          const response=await fetchFn(path,{
            credentials:"omit",cache:"no-store",signal:controller.signal,
            headers:{Authorization:"Bearer "+token}
          });
          if(!response.ok)throw new Error("API_HTTP_"+response.status);
          const result=await response.json();
          if(!result||typeof result!=="object")
            throw new Error("INVALID_API_RESPONSE");
          return result;
        }
        // Complete project catalog, not merely projects visible in the sidebar.
        let cursor="",projectPages=0;
        const projectCursors=new Set();
        do{
          if(++projectPages>120)throw new Error("PROJECT_CATALOG_LIMIT");
          const params=new URLSearchParams({
            conversations_per_gizmo:"5",limit:"20",owned_only:"false"
          });
          if(cursor)params.set("cursor",cursor);
          const data=await api("/backend-api/gizmos/snorlax/sidebar?"+params);
          if(!Array.isArray(data.items))throw new Error("INVALID_PROJECT_CATALOG");
          for(const row of data.items){
            const id=[row?.gizmo?.gizmo?.id,row?.gizmo?.id,row?.id,
              row?.gizmo_id,row?.project?.id].find(x=>
                typeof x==="string"&&PROJECT.test(x));
            const page=row?.conversations||row?.gizmo?.conversations||{};
            if(!id){
              if(page?.cursor)throw new Error("PROJECT_MISSING_ID");
              continue;
            }
            const title=String(row?.gizmo?.gizmo?.display?.name||
              row?.gizmo?.gizmo?.name||row?.gizmo?.display?.name||
              row?.gizmo?.name||row?.title||"").slice(0,120);
            if(projects.has(id))throw new Error("DUPLICATE_PROJECT_PAGE");
            projects.set(id,{title,cursor:String(page?.cursor||"")});
            if(!Array.isArray(page?.items))throw new Error("INVALID_EMBEDDED_PROJECT");
            for(const chat of page.items)add(chat,title);
          }
          const next=typeof data.cursor==="string"?data.cursor:"";
          if(next&&(!data.items.length||next===cursor||projectCursors.has(next)))
            throw new Error("INVALID_PROJECT_CURSOR");
          if(next)projectCursors.add(next);
          cursor=next;
        }while(cursor);
        for(const [id,project] of projects){
          let next=project.cursor,page=0;
          const seenCursors=new Set();
          while(next){
            if(++page>150||seenCursors.has(next))
              throw new Error("INVALID_PROJECT_PAGINATION");
            seenCursors.add(next);
            const params=new URLSearchParams({limit:"50",owned_only:"false",cursor:next});
            const data=await api("/backend-api/gizmos/"+encodeURIComponent(id)+
              "/conversations?"+params);
            if(!Array.isArray(data.items))throw new Error("INVALID_PROJECT_ITEMS");
            for(const chat of data.items)add(chat,project.title);
            const cursor2=typeof data.cursor==="string"?data.cursor:"";
            if(cursor2&&!data.items.length)throw new Error("EMPTY_PROJECT_PAGE_WITH_CURSOR");
            next=cursor2;
          }
        }
        // Every page of global conversations, irrespective of viewport / first 180.
        let offset=0,total=null,globalPages=0;
        while(true){
          if(++globalPages>300)throw new Error("GLOBAL_PAGE_LIMIT");
          const data=await api("/backend-api/conversations?offset="+offset+"&limit=100");
          if(!Array.isArray(data.items))throw new Error("INVALID_GLOBAL_ITEMS");
          if(typeof data.total==="number"&&Number.isFinite(data.total)){
            if(total!==null&&total!==data.total)
              throw new Error("TOTAL_CHANGED_DURING_SCAN");
            total=data.total;
          }
          for(const chat of data.items){
            const id=String(chat?.uuid||chat?.id||"").toLowerCase();
            if(UUID.test(id)){
              if(seenGlobal.has(id))throw new Error("GLOBAL_PAGINATION_DUPLICATE");
              seenGlobal.add(id);
            }
            add(chat);
          }
          offset+=data.items.length;
          if(total!==null&&offset>=total)break;
          if(data.items.length<100){
            if(total!==null&&offset<total)
              throw new Error("TRUNCATED_GLOBAL_PAGINATION");
            break;
          }
        }
        check(controller.signal);
        if(!found.size)throw new Error("EMPTY_COMPLETE_SCAN");
        scanId=crypto.randomUUID();
        const startedResult=await sendFn({type:"SUP_INVENTORY_START",
          scan_id:scanId,account_key:accountKey});
        if(!startedResult?.ok)
          throw new Error("INVENTORY_START_"+(startedResult?.error||"UNKNOWN"));
        started=true;
        const items=[...found.values()];
        for(let i=0;i<items.length;i+=75){
          check(controller.signal);
          const pageNo=Math.floor(i/75);
          const result=await sendFn({type:"SUP_INVENTORY_PAGE",
            scan_id:scanId,account_key:accountKey,page:pageNo,
            items:items.slice(i,i+75)});
          if(!result?.ok)
            throw new Error("INVENTORY_UPLOAD_"+(result?.error||"UNKNOWN"));
        }
        check(controller.signal);
        const result=await sendFn({type:"SUP_INVENTORY_FINISH",
          scan_id:scanId,account_key:accountKey,
          global_complete:true,projects_complete:true,
          unique_count:items.length});
        if(!result?.ok)
          throw new Error("INVENTORY_FINISH_"+(result?.error||"UNKNOWN"));
        onResult(result);
        return result;
      }catch(e){
        lastError=String(e.message||e);
        if(started&&scanId&&accountKey){
          try{await sendFn({type:"SUP_INVENTORY_ABORT",scan_id:scanId,
            account_key:accountKey});}catch(_){}
        }
        return {ok:false,error:lastError,paused:controller.signal.aborted};
      }finally{
        if(abort===controller)abort=null;
        running=false;
      }
    }
    return {run,pause,snapshot};
  }
  root.CGSCreateInventoryScanner=createInventoryScanner;
  if(typeof module!=="undefined"&&module.exports)
    module.exports=createInventoryScanner;
})(typeof globalThis!=="undefined"?globalThis:this);
