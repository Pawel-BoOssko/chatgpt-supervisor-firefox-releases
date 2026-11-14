"use strict";
// Read-only ChatGPT conversation index. Session credentials remain in memory
// and are sent only to chatgpt.com; never to the local bridge.
(function(root){
  const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const normalize=x=>String(x||"").normalize("NFKD")
    .replace(/[\u0300-\u036f]/g,"").toLowerCase();
  function createChatIndex({fetchFn,onUpdate=()=>{},loadProfiles=async()=>{},
                            shouldContinue=()=>false}={}){
    const request=fetchFn||(root.window?.fetch
      ? root.window.fetch.bind(root.window):root.fetch.bind(root));
    const entries=new Map(),profileLoadedIds=new Set(),projectCatalog=new Map();
    let projectListLoaded=false,projectListError="",projectListInflight=null;
    let loading=false,loaded=false,complete=false,error="",lastAt=0,revision=0;
    let projectsComplete=false,globalComplete=false,globalOffset=0;
    let active=null,retryTimer=null,retryCount=0;
    const notify=()=>{revision++;onUpdate();};
    function add(item,source="native"){
      const uuid=String(item?.uuid||item?.id||"").toLowerCase();
      if(!UUID.test(uuid)||item?.is_archived===true)return false;
      const title=String(item.title||"").trim().slice(0,240);
      const previous=entries.get(uuid);
      const updated=Number(item.update_time||item.updated||0)||0;
      const next={
        uuid,title:title||previous?.title||uuid,
        updated:updated||previous?.updated||0,
        project:String(item.project||previous?.project||""),
        source:source==="native"&&previous?.source==="api"?"api":source
      };
      if(previous && previous.title===next.title && previous.updated===next.updated &&
         previous.project===next.project && previous.source===next.source)return false;
      entries.set(uuid,next);revision++;return true;
    }
    function remove(uuid){
      const removed=entries.delete(String(uuid).toLowerCase());
      if(removed)notify();
      return removed;
    }
    function search(term,profiles={}){
      const q=normalize(String(term||"").trim());
      if(!q)return [];
      return [...entries.values()].filter(item=>
        normalize(item.title).includes(q)||
        normalize(profiles[item.uuid]?.imeno||"").includes(q))
        .sort((a,b)=>b.updated-a.updated||a.title.localeCompare(b.title,"pl"));
    }
    function rememberProject(id,name){
      if(typeof id!=="string"||!/^g-p-[\\w-]+$/i.test(id))return;
      const label=String(name||"").trim().slice(0,120);
      if(label)projectCatalog.set(id,label);
    }
    function projects(){
      return [...projectCatalog].map(([id,name])=>({id,name}))
        .sort((a,b)=>a.name.localeCompare(b.name,"pl")||a.id.localeCompare(b.id));
    }
    function projectState(){
      return {loaded:projectListLoaded,loading:!!projectListInflight,
        error:projectListError,count:projectCatalog.size};
    }
    async function loadProjectList(force=false){
      if(projectListInflight)return projectListInflight;
      if(projectListLoaded&&!force)return {ok:true,projects:projects()};
      projectListInflight=(async()=>{
        let token="",cursor="",page=0;
        projectListError="";
        try{
          const auth=await request("/api/auth/session",{
            credentials:"include",cache:"no-store"});
          if(!auth.ok)throw new Error("sesja HTTP "+auth.status);
          token=String((await auth.json()).accessToken||"");
          if(!token)throw new Error("brak tokenu sesji");
          do{
            if(++page>100)throw new Error("limit stron listy projektów");
            const params=new URLSearchParams({
              conversations_per_gizmo:"5",limit:"20",owned_only:"false"});
            if(cursor)params.set("cursor",cursor);
            const response=await request(
              "/backend-api/gizmos/snorlax/sidebar?"+params,{
                credentials:"omit",cache:"no-store",
                headers:{Authorization:"Bearer "+token}
              });
            if(!response.ok)throw new Error("HTTP "+response.status);
            const data=await response.json();
            if(!Array.isArray(data.items))throw new Error("niepoprawna lista projektów");
            for(const item of data.items){
              const id=[item?.gizmo?.gizmo?.id,item?.gizmo?.id,
                item?.id,item?.gizmo_id,item?.project?.id]
                .find(x=>typeof x==="string"&&/^g-p-[\\w-]+$/i.test(x));
              const name=item?.gizmo?.gizmo?.display?.name||
                item?.gizmo?.gizmo?.name||item?.gizmo?.display?.name||
                item?.gizmo?.name||item?.title||"";
              rememberProject(id,name);
            }
            const next=typeof data.cursor==="string"?data.cursor:"";
            if(!next||next===cursor)break;
            cursor=next;
          }while(true);
          projectListLoaded=true;
          notify();
          return {ok:true,projects:projects()};
        }catch(e){
          projectListError=String(e.message||e);
          notify();
          return {ok:false,error:projectListError,projects:projects()};
        }finally{token="";projectListInflight=null;}
      })();
      return projectListInflight;
    }
    async function verifyProject(uuid,projectId){
      if(!UUID.test(uuid||"")||!/^g-p-[\\w-]+$/i.test(projectId||""))
        return null;
      try{
        const auth=await request("/api/auth/session",{
          credentials:"include",cache:"no-store"});
        if(!auth.ok)return null;
        let token=String((await auth.json()).accessToken||"");
        if(!token)return null;
        const response=await request("/backend-api/conversation/"+
          encodeURIComponent(uuid),{credentials:"omit",cache:"no-store",
          headers:{Authorization:"Bearer "+token}});
        token="";
        if(!response.ok)return null;
        const data=await response.json();
        const found=[data?.gizmo_id,data?.conversation?.gizmo_id,
          data?.gizmo?.id].filter(x=>typeof x==="string");
        return found.length?found.includes(projectId):null;
      }catch(e){return null;}
    }
    async function moveToProject(uuid,projectId){
      if(!UUID.test(uuid||"")||!projectCatalog.has(projectId))
        throw new Error("Nieprawidłowy UUID lub projekt spoza listy");
      const known=entries.get(uuid);
      if(!known)throw new Error("Rozmowa nie znajduje się w indeksie");
      const auth=await request("/api/auth/session",{
        credentials:"include",cache:"no-store"});
      if(!auth.ok)throw new Error("Sesja ChatGPT HTTP "+auth.status);
      let token=String((await auth.json()).accessToken||"");
      if(!token)throw new Error("Brak tokenu sesji ChatGPT");
      const path="/backend-api/conversation/"+encodeURIComponent(uuid);
      const headers={Authorization:"Bearer "+token};
      const current=await request(path,{credentials:"omit",cache:"no-store",headers});
      if(!current.ok)throw new Error("Odczyt rozmowy HTTP "+current.status);
      const before=await current.json();
      if(before.gizmo_id===projectId){
        token="";
        markMoved(uuid,projectId);
        return {ok:true,already:true};
      }
      if(before.is_archived===true||before.is_visible===false)
        throw new Error("Rozmowa jest zarchiwizowana lub usunięta");
      // PATCH is the same same-origin operation as ChatGPT's Move to project.
      const response=await request(path,{method:"PATCH",credentials:"omit",
        cache:"no-store",headers:{...headers,"Content-Type":"application/json"},
        body:JSON.stringify({gizmo_id:projectId})});
      if(!response.ok)throw new Error("Przenoszenie HTTP "+response.status);
      await new Promise(resolve=>setTimeout(resolve,250));
      const check=await request(path,{credentials:"omit",cache:"no-store",headers});
      token="";
      if(!check.ok)throw new Error("Weryfikacja HTTP "+check.status);
      const after=await check.json();
      if(after.gizmo_id!==projectId)
        throw new Error("Serwer nie potwierdził zmiany projektu");
      markMoved(uuid,projectId);
      return {ok:true,already:false};
    }
    function markMoved(uuid,projectId){
      const entry=entries.get(uuid);
      if(!entry||!projectCatalog.has(projectId))return false;
      entries.set(uuid,{...entry,project:projectCatalog.get(projectId)});
      notify();return true;
    }
    function snapshot(){
      return {size:entries.size,loading,loaded,complete,error,lastAt,revision,
        projectsComplete,globalComplete,globalOffset,retryCount};
    }
    function scheduleRetry(){
      if(complete||!shouldContinue()||retryCount>=8)return;
      if(retryTimer)clearTimeout(retryTimer);
      const delay=Math.min(300000,30000*Math.pow(2,retryCount++));
      retryTimer=setTimeout(()=>{
        retryTimer=null;
        if(shouldContinue())load(true).catch(()=>{});
      },delay);
    }
    async function load(force=false){
      if(loading)return active;
      if(!force && complete && Date.now()-lastAt<300000)return snapshot();
      if(!force && loaded && Date.now()-lastAt<30000)return snapshot();
      if(retryTimer){clearTimeout(retryTimer);retryTimer=null;}
      loading=true;error="";notify();
      active=(async()=>{
        const problems=[];
        let token="";
        try{
          const auth=await request("/api/auth/session",{credentials:"include",cache:"no-store"});
          if(!auth.ok)throw new Error("sesja HTTP "+auth.status);
          const session=await auth.json();
          token=String(session.accessToken||"");
          if(!token)throw new Error("brak tokenu sesji");
          let requestCount=0;
          async function api(path){
            if(!path.startsWith("/backend-api/"))throw new Error("invalid_api_path");
            if(requestCount++>=240)throw new Error("limit 240 odczytów API");
            await new Promise(resolve=>setTimeout(resolve,130));
            const res=await request(path,{credentials:"omit",cache:"no-store",
              headers:{Authorization:"Bearer "+token}});
            if(!res.ok)throw new Error("HTTP "+res.status+" dla "+
              path.split("?")[0].replace(/g-p-[\w-]+/g,"{projekt}"));
            return res.json();
          }
          if(!projectsComplete){
            const projects=[];
            let sidebarComplete=false;
            try{
              let cursor="",page=0,more=true;
              while(more && page++<100){
                const params=new URLSearchParams({
                  conversations_per_gizmo:"5",limit:"20",owned_only:"false"});
                if(cursor)params.set("cursor",cursor);
                const response=await api("/backend-api/gizmos/snorlax/sidebar?"+params);
                if(!Array.isArray(response.items))throw new Error("invalid_sidebar_items");
                for(const item of response.items){
                  const id=[item?.gizmo?.gizmo?.id,item?.gizmo?.id,
                    item?.id,item?.gizmo_id,item?.project?.id]
                    .find(x=>typeof x==="string"&&/^g-p-[\w-]+$/i.test(x));
                  const conversationPage=item?.conversations||item?.gizmo?.conversations||{};
                  const projectName=String(item?.gizmo?.gizmo?.display?.name||
                    item?.gizmo?.gizmo?.name||item?.gizmo?.display?.name||
                    item?.gizmo?.name||item?.title||"").slice(0,120);
                  const embedded=Array.isArray(conversationPage.items)?conversationPage.items:[];
                  for(const chat of embedded)add({...chat,project:projectName},"api");
                  rememberProject(id,projectName);
                  if(id)projects.push({id,cursor:conversationPage.cursor||"",name:projectName});
                  else if(conversationPage.cursor)problems.push("projekt bez identyfikatora");
                }
                notify();
                const next=typeof response.cursor==="string"?response.cursor:"";
                more=!!next&&next!==cursor;
                cursor=next;
              }
              if(more)throw new Error("przekroczono limit stron projektów");
              sidebarComplete=true;
            }catch(e){problems.push("projekty: "+(e.message||e));}
            let projectPagesComplete=sidebarComplete;
            // The embedded cursor was verified against this endpoint.
            for(const project of projects){
              try{
                let cursor=project.cursor,page=0,more=!!project.cursor;
                while(more && page++<120){
                  const params=new URLSearchParams({limit:"50",owned_only:"false"});
                  params.set("cursor",cursor);
                  const response=await api("/backend-api/gizmos/"+
                    encodeURIComponent(project.id)+"/conversations?"+params);
                  if(!Array.isArray(response.items))throw new Error("invalid_project_items");
                  for(const chat of response.items)add({...chat,project:project.name},"api");
                  notify();
                  const next=typeof response.cursor==="string"?response.cursor:"";
                  more=!!next&&next!==cursor;
                  cursor=next;
                }
                if(more)throw new Error("limit stron");
              }catch(e){
                projectPagesComplete=false;
                problems.push("rozmowy projektu: "+(e.message||e));
              }
            }
            projectsComplete=projectPagesComplete && !problems.some(x=>x==="projekt bez identyfikatora");
            if(sidebarComplete)projectListLoaded=true;
          }
          if(!globalComplete){
            try{
              let page=0,done=false;
              while(!done && page++<150){
                const response=await api("/backend-api/conversations?offset="+
                  globalOffset+"&limit=100");
                if(!Array.isArray(response.items))throw new Error("invalid_global_items");
                for(const chat of response.items)add(chat,"api");
                notify();
                const n=response.items.length;
                globalOffset+=n;
                done=n===0||n<100||
                  (typeof response.total==="number"&&globalOffset>=response.total);
                if(done && globalOffset===0 && entries.size>0)
                  throw new Error("API zwróciło pustą listę mimo istniejących rozmów");
              }
              if(!done)throw new Error("limit stron globalnych");
              globalComplete=true;
            }catch(e){problems.push("poza projektami: "+(e.message||e));}
          }
          const ids=[...entries.keys()].filter(id=>!profileLoadedIds.has(id));
          for(let i=0;i<ids.length;i+=150){
            const batch=ids.slice(i,i+150);
            try{await loadProfiles(batch);for(const id of batch)profileLoadedIds.add(id);}
            catch(e){problems.push("imeno: błąd odczytu profili");}
            notify();
          }
        }catch(e){problems.push("sesja: "+(e.message||e));}
        finally{
          token="";
          loading=false;loaded=true;lastAt=Date.now();
          complete=projectsComplete&&globalComplete;
          error=problems.join("; ").slice(0,800);
          notify();
          if(!complete && error.includes("429"))scheduleRetry();
        }
        return snapshot();
      })();
      return active;
    }
    return {add,remove,search,load,snapshot,entries,projects,projectState,
      loadProjectList,verifyProject,markMoved,moveToProject};
  }
  root.CGSCreateChatIndex=createChatIndex;
  if(typeof module!=="undefined"&&module.exports)module.exports=createChatIndex;
})(typeof globalThis!=="undefined"?globalThis:this);
