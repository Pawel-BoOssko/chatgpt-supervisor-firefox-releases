"use strict";
(() => {
  if (globalThis.__cgsStatusPanelStarted) return;
  globalThis.__cgsStatusPanelStarted = true;

  const UUID_PATH = /^\/c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\/|$)/i;
  const UUID_LINK = /\/c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\/|$)/i;
  const COLORS = ["green","red","yellow","blue","teal","gray","muted"];
  const STATUS_CLASSES = COLORS.map(x => "cgs-" + x);
  const JOIN_PROMPT = [
    "Zgłoś tę rozmowę do Nadzoru przez dostępny serwer MCP.",
    "Podaj przede wszystkim pełną ścieżkę swojego rzeczywistego katalogu roboczego na SATANAMD",
    "oraz wszystkie dane identyfikacyjne, o które poprosi serwer MCP, w tym MCP_NICK, MCP_ID",
    "i UUID, jeśli zostały potwierdzone przez serwer. Nie wymyślaj identyfikatorów.",
    "Jeżeli nie masz jeszcze MCP_NICK: wybierz trzy losowe słowa alfabetu NATO, połącz je",
    "bez spacji i dodaj trzy cyfry. Łącznie część literowa ma mieć 7-20 liter.",
    "Koniecznie pokaż w zwykłej treści odpowiedzi poprawny znacznik",
    "MCP_NICK:@@@TWOJWYBRANYNICK123@@@, zastępując ten przykład rzeczywistym nickiem.",
    "Nie umieszczaj go wyłącznie w bloku kodu. Rejestr przeglądarki wyłapie go jako",
    "kandydaturę, a powiązanie z MCP_ID musi zostać potwierdzone przez MCP.",
    "Wykonaj rejestrację we właściwym mechanizmie MCP, a następnie podaj katalog",
    "i faktyczny wynik zgłoszenia. Nie odczytuj bezpośrednio bazy SQLite Nadzoru."
  ].join(" ");
  let states = Object.create(null);
  let connected = false;
  let generatedAt = "";
  let toolbar = null;
  let busy = false;
  let lastPath = location.pathname;
  let navObserver = null;
  let navRoot = null;
  let scanQueued = false;
  let loadRunning = false;
  const profiles=Object.create(null);
  const originalTitles=new WeakMap();
  let profileLoadRunning=false;
  let profileLoadAt=0;
  let lastProfileSignature="";
  let observationLastAt=0;
  let observationLastSuccess="";
  let observationLastTryAt=0;

  function ageMinutes(value) {
    const ms = Date.parse(value || "");
    return Number.isFinite(ms) ? Math.max(0, (Date.now() - ms) / 60000) : null;
  }
  function classify(item) {
    if (!item) return {color:"gray",label:"Brak w rejestrze Nadzoru",registered:false};
    const status = String(item.status || "").toUpperCase();
    const registered = !["POZA","BRAK_W_BAZIE","ANULOWANY","ZASTAPIONY","ARCHIWIZACJA_ZLECONA"].includes(status);
    if (status === "POZA" || status === "BRAK_W_BAZIE")
      return {color:"gray",label:"Poza Nadzorem: "+status,registered:false};
    if (["ANULOWANY","ZASTAPIONY","ARCHIWIZACJA_ZLECONA"].includes(status))
      return {color:"muted",label:"Nieaktywny: "+status,registered:false};
    if (["DO_WYJASNIENIA","PYTANIE_JSON_1","PYTANIE_JSON_2","PYTANIE_JSON_3"].includes(status))
      return {color:"teal",label:"Wyjaśnienie: "+status,registered:true};
    if (status.startsWith("WYBUDZENIE_") || item.queue_pending)
      return {color:"yellow",label:"Wybudzanie: "+status,registered:true};
    if (["DO_ROTACJI","BRAK_ODPOWIEDZI","ZATRZYMANY","DO_DECYZJI"].includes(status))
      return {color:"red",label:"Wymaga reakcji: "+status,registered:true};
    if (["KONIEC_OD_CZATU","POWIADOMIENIE_ZLECONE","POWIADOMIENIE_ODEBRANE","EMOTKA_ZIELONA"].includes(status))
      return {color:"blue",label:"Kończenie pracy: "+status,registered:true};
    if (status === "PRACUJE") return {color:"green",label:"W Nadzorze: PRACUJE",registered:true};
    return {color:"gray",label:"Nieznany status: "+status,registered};
  }

  const STATUS_RGB = {
    green:[27,183,109],red:[239,83,93],yellow:[226,180,56],
    blue:[78,154,241],teal:[55,194,189],gray:[139,149,164],muted:[89,101,115]
  };
  const interpolate = (a,b,t) => a+(b-a)*Math.min(1,Math.max(0,t));
  const logProgress = (age,lo,hi) =>
    Math.max(0,Math.min(1,Math.log(Math.max(lo,age)/lo)/Math.log(hi/lo)));
  const rgba = (rgb,alpha) =>
    "rgba("+rgb.map(Math.round).join(",")+","+alpha.toFixed(3)+")";

  function fileAgeColor(activity) {
    if (!activity) return {fill:"rgba(128,136,146,0.035)",info:"Brak odczytu folderu z Neo4j"};
    if (activity.error) return {fill:"rgba(128,136,146,0.075)",info:"Folder niedostępny: "+activity.error};
    const min=ageMinutes(activity.last_modified);
    if (min===null) return {fill:"rgba(128,136,146,0.040)",info:"Brak kwalifikujących się plików"};
    let fill;
    if (min<=10) {
      fill=rgba([19,205,113],.48);
    } else if (min<=60) {
      const t=logProgress(min,10,60);
      fill=rgba([interpolate(19,96,t),interpolate(205,189,t),interpolate(113,120,t)],
                interpolate(.48,.30,t));
    } else if (min<=720) {
      const t=logProgress(min,60,720);
      fill=rgba([interpolate(96,168,t),interpolate(189,170,t),interpolate(120,166,t)],
                interpolate(.30,0,t));
    } else if (min<=2880) {
      const t=logProgress(min,720,2880);
      fill=rgba([76,82,92],interpolate(0,.35,t));
    } else {
      fill=rgba([68,75,86],.35);
    }
    const hours=min/60;
    const elapsed=min<60 ? Math.round(min)+" min" : hours<48 ?
        hours.toFixed(1)+" h" : Math.round(hours)+" h";
    return {fill,info:"Ostatnia modyfikacja pliku: "+elapsed+" temu",
            minute:Math.floor(min)};
  }
  function titleTextNode(link) {
    const walker=document.createTreeWalker(link,NodeFilter.SHOW_TEXT);
    let node,best=null,bestScore=-1;
    while ((node=walker.nextNode())) {
      const content=(node.nodeValue||"").trim();
      const parent=node.parentElement;
      if (!parent || !content || content.length>240 ||
          parent.closest("button,[role='button'],svg,[aria-hidden='true']")) continue;
      let score=content.length;
      if (/truncate|overflow-hidden/i.test(parent.className||""))score+=60;
      if (score>bestScore){bestScore=score;best=node;}
    }
    return best;
  }
  function originalTitle(link) {
    let rec=originalTitles.get(link);
    if (rec && link.contains(rec.node)) {
      const now=rec.node.nodeValue;
      if (now!==rec.applied && now!==rec.original) rec.original=now;
      return rec.original.trim();
    }
    const node=titleTextNode(link);
    return node ? (node.nodeValue||"").trim() : "";
  }
  function showImeno(link,profile) {
    if (!profile) return;
    const imeno=typeof profile.imeno==="string" ? profile.imeno.trim() : "";
    let rec=originalTitles.get(link);
    if (rec && !link.contains(rec.node)) {
      originalTitles.delete(link);rec=null;
    }
    if (!imeno) {
      if (rec && rec.node.nodeValue===rec.applied)rec.node.nodeValue=rec.original;
      originalTitles.delete(link);
      return;
    }
    if (!rec) {
      const node=titleTextNode(link);
      if (!node)return;
      rec={node,original:node.nodeValue,applied:""};
      originalTitles.set(link,rec);
    }
    if (rec.node.nodeValue!==imeno) {
      if (rec.node.nodeValue!==rec.applied)rec.original=rec.node.nodeValue;
      rec.node.nodeValue=imeno;
    }
    rec.applied=imeno;
    link.dataset.cgsImeno=imeno;
  }
  function profileFileActivity(profile) {
    const folders=profile && Array.isArray(profile.folders) ? profile.folders : [];
    let best=null;
    for(const f of folders){
      if (!f || !f.path)continue;
      const item={
        folder:f.path,host:f.host,
        last_modified:f.file_last_modified_at||null,
        observed_at:f.scanned_at||null,
        error:f.scan_status && f.scan_status!=="OK" ? f.scan_status : null
      };
      if (!best || ((item.last_modified||"")>(best.last_modified||"")))
        best=item;
    }
    return best;
  }
  function currentVisibleIds() {
    const ids=[],set=new Set();
    const id=currentUuid();
    if (id){ids.push(id);set.add(id);}
    for(const link of document.querySelectorAll("a[href*='/c/']")){
      if (!isSidebarLink(link))continue;
      const uuid=uuidForLink(link);
      if (!uuid || set.has(uuid))continue;
      set.add(uuid);ids.push(uuid);
      if(ids.length>=180)break;
    }
    return ids;
  }
  async function refreshProfiles(force=false) {
    if (profileLoadRunning)return;
    const ids=currentVisibleIds();
    if(!ids.length)return;
    const signature=ids.join(",");
    if (!force && signature===lastProfileSignature &&
        Date.now()-profileLoadAt<24000)return;
    profileLoadRunning=true;
    try {
      const data=await browser.runtime.sendMessage({
        type:"SUP_PROFILE_GET",uuids:ids,force:!!force});
      if (data && Array.isArray(data.items)) {
        for(const p of data.items){
          if (p && p.uuid)profiles[p.uuid.toLowerCase()]=p;
        }
        if(data.ok){lastProfileSignature=signature;profileLoadAt=Date.now();}
        filterRenderRevision++;queueScan();
      }
    }catch(e){}finally{profileLoadRunning=false;}
  }
  function ownMcpNickFromAssistant() {
    const assistantMessages=[...document.querySelectorAll(
      "[data-message-author-role='assistant'],[data-testid*='assistant-message']"
    )].slice(-3);
    const found=new Set();
    const marker=/(?:^|[^\p{L}0-9_])MCP_NICK:@@@([\p{L}]{7,20}[0-9]{3})@@@/gu;
    for(const message of assistantMessages){
      let text="",walker=document.createTreeWalker(message,NodeFilter.SHOW_TEXT),node;
      while((node=walker.nextNode()) && text.length<12000){
        if(node.parentElement && node.parentElement.closest("pre,code,blockquote"))continue;
        text+=(node.nodeValue||"");
      }
      for(const match of text.matchAll(marker)){
        found.add("MCP_NICK:@@@"+match[1].toUpperCase()+"@@@");
      }
    }
    return found.size===1 ? [...found][0] : null;
  }
  async function observeCurrentChat() {
    const uuid=currentUuid();
    if(!uuid || document.hidden)return;
    const now=Date.now();
    if (now-observationLastTryAt<9000)return;
    observationLastTryAt=now;
    const link=[...document.querySelectorAll("a[href*='/c/']")]
      .find(x=>isSidebarLink(x) && uuidForLink(x)===uuid);
    let title=link ? originalTitle(link) : "";
    if(!title || title===profiles[uuid]?.imeno){
      const documentTitle=(document.title||"").replace(/\s*[-–|]\s*ChatGPT\s*$/i,"").trim();
      if(documentTitle && documentTitle.toLowerCase()!=="chatgpt")
        title=documentTitle;
      else title="";
    }
    const declaration=ownMcpNickFromAssistant();
    const signature=uuid+"|"+title+"|"+(declaration||"");
    if(signature===observationLastSuccess && now-observationLastAt<300000)return;
    try{
      const result=await browser.runtime.sendMessage({
        type:"SUP_BROWSER_OBSERVE",uuid,title,
        ...(declaration?{mcp_nick_declaration:declaration}:{})
      });
      if(result && result.ok){
        observationLastSuccess=signature;
        observationLastAt=now;
      }
    }catch(e){}
  }
  function currentUuid() {
    const m = UUID_PATH.exec(location.pathname);
    return m ? m[1].toLowerCase() : null;
  }
  function uuidForLink(a) {
    const url = a.getAttribute("href") || "";
    const m = UUID_LINK.exec(url);
    return m ? m[1].toLowerCase() : null;
  }
  function isSidebarLink(a) {
    return !!a.closest("nav,aside,[data-testid*='sidebar'],[data-sidebar-item],[role='navigation']");
  }

  const bulkSelected=new Set();
  let bulkFilter="",bulkPanel=null,bulkResult=null,bulkBusy=false;
  const bulkFilters={importance:"all",work:"all",sort:"updated"};
  let filterRenderRevision=0,projectTarget="";
  const model=globalThis.CGSFilterModel;
  const filtersActive=()=>!!bulkFilter.trim()||
    bulkFilters.importance!=="all"||bulkFilters.work!=="all"||
    bulkFilters.sort!=="updated";
  const modelFilters=()=>({term:bulkFilter,...bulkFilters});

  const normalized=value=>(value||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase();

  let bulkSurface=null,bulkSurfaceBasePadding="0px";
  let filterResultLimit=100,filterSearchTimer=null;
  const chatIndex=typeof globalThis.CGSCreateChatIndex==="function"
    ? globalThis.CGSCreateChatIndex({
      onUpdate:()=>queueScan(),
      shouldContinue:()=>!!bulkFilter.trim()&&!document.hidden,
      loadProfiles:async ids=>{
        if(!ids.length)return;
        try{
          const data=await browser.runtime.sendMessage({
            type:"SUP_PROFILE_GET",uuids:ids,force:false});
          if(data?.ok && Array.isArray(data.items))
            for(const p of data.items)if(p?.uuid)profiles[p.uuid.toLowerCase()]=p;
        }catch(e){}
      }
    }):null;
  function nativeSidebarRows(){
    return sidebarRows().filter(a=>!a.closest("#cgs-filter-results"));
  }
  function seedNativeIndex(){
    if(!chatIndex)return;
    for(const a of nativeSidebarRows()){
      const id=uuidForLink(a),title=originalTitle(a);
      if(id&&title)chatIndex.add({uuid:id,title},"native");
    }
  }
  function filteredItems(){
    const source=chatIndex?[...chatIndex.entries.values()]:
      nativeSidebarRows().map(a=>({uuid:uuidForLink(a),
        title:originalTitle(a),updated:0}));
    if(model)return model.sorted(source,profiles,states,modelFilters());
    const term=normalized(bulkFilter.trim());
    return source.filter(item=>normalized(item.title).includes(term)||
      normalized(profiles[item.uuid]?.imeno||"").includes(term));
  }
  function filterResultsContainer(){
    const scroll=document.querySelector(
      "#app-shell-sidebar [data-app-action-sidebar-scroll]");
    if(!scroll)return null;
    let results=scroll.querySelector("#cgs-filter-results");
    if(!results){
      results=document.createElement("div");
      results.id="cgs-filter-results";
      results.setAttribute("aria-label","Wyniki filtrowania rozmów");
      scroll.prepend(results);
    }
    return results;
  }
  function renderFilterResults(){
    const container=filterResultsContainer();
    if(!container)return;
    if(!filtersActive()){container.hidden=true;container.replaceChildren();return;}
    container.hidden=false;
    const matches=filteredItems();
    const state=chatIndex?.snapshot();
    const signature=[JSON.stringify(modelFilters()),filterResultLimit,
      state?.revision||0,filterRenderRevision,
      [...bulkSelected].sort().join(","),matches.length].join("|");
    if(container.dataset.cgsSignature===signature)return;
    container.dataset.cgsSignature=signature;
    const fragment=document.createDocumentFragment();
    for(const item of matches.slice(0,filterResultLimit)){
      const row=document.createElement("div");
      row.className="cgs-result-row";
      const status=classify(states[item.uuid]);
      row.style.setProperty("--cgs-result-color",
        "rgb("+(STATUS_RGB[status.color]||STATUS_RGB.gray).join(",")+")");
      const important=profiles[item.uuid]?.important===1;
      row.classList.add("cgs-"+status.color);
      row.classList.toggle("cgs-important",important);
      const activity=important?fileAgeColor(states[item.uuid]?.activity||
        profileFileActivity(profiles[item.uuid])):null;
      row.style.setProperty("--cgs-left-fill",rgba(STATUS_RGB[status.color]||
        STATUS_RGB.gray,.28));
      row.style.setProperty("--cgs-right-fill",activity?.fill||"transparent");
      row.title=status.label+(important?" | Ważny":"")+
        (activity?" | "+activity.info:"");
      row.dataset.cgsResultUuid=item.uuid;
      const checkbox=document.createElement("input");
      checkbox.type="checkbox";checkbox.className="cgs-result-check";
      checkbox.checked=bulkSelected.has(item.uuid);
      checkbox.setAttribute("aria-label","Zaznacz rozmowę");
      checkbox.addEventListener("change",()=>{
        if(checkbox.checked)bulkSelected.add(item.uuid);
        else bulkSelected.delete(item.uuid);
        applyBulkFilter();
      });
      const link=document.createElement("a");
      link.href="/c/"+item.uuid;
      link.textContent=profiles[item.uuid]?.imeno||item.title;
      link.title=item.title;
      link.className="cgs-result-link";
      row.append(checkbox,link);fragment.append(row);
    }
    if(matches.length>filterResultLimit){
      const more=document.createElement("button");
      more.type="button";more.className="cgs-results-more";
      more.textContent="Pokaż kolejne ("+(matches.length-filterResultLimit)+")";
      more.addEventListener("click",()=>{
        filterResultLimit+=100;
        renderFilterResults();
      });
      fragment.append(more);
    }
    if(!matches.length){
      const empty=document.createElement("div");
      empty.className="cgs-results-empty";
      empty.textContent=state?.loading
        ?"Wyszukiwanie w historii rozmów…"
        :"Brak dopasowań w załadowanej historii.";
      fragment.append(empty);
    }
    container.replaceChildren(fragment);
  }
  function scheduleIndexLoad(force=false){
    if(!chatIndex)return;
    clearTimeout(filterSearchTimer);
    filterSearchTimer=setTimeout(()=>{
      if(!filtersActive())return;
      chatIndex.load(force).catch(()=>queueScan());
    },250);
  }
  function positionBulkPanel(sidebar,panel){
    if(!sidebar||!panel)return;
    if(getComputedStyle(sidebar).position==="static")
      sidebar.style.position="relative";
    const newChat=[...sidebar.querySelectorAll(
      "button[aria-label='Nowy czat'],button[aria-label='New chat']"
    )].find(el=>el.getClientRects().length>0);
    let surface=newChat;
    while(surface && surface.parentElement!==sidebar)
      surface=surface.parentElement;
    if(!surface || surface===panel)
      surface=sidebar.querySelector(":scope > div:has([data-sidebar-navigation-root])")||
              sidebar.querySelector(":scope > div")||sidebar;
    if(bulkSurface!==surface){
      if(bulkSurface && bulkSurface!==sidebar)
        bulkSurface.style.removeProperty("padding-top");
      bulkSurface=surface;
      bulkSurfaceBasePadding=getComputedStyle(surface).paddingTop||"0px";
    }
    const height=Math.ceil(panel.getBoundingClientRect().height||
      panel.offsetHeight||190)+32;
    const desired="calc("+bulkSurfaceBasePadding+" + "+height+"px)";
    if(surface.style.getPropertyValue("padding-top")!==desired)
      surface.style.setProperty("padding-top",desired,"important");
  }
  function sidebarRows(){
    return [...document.querySelectorAll("a[href*='/c/']")]
      .filter(a=>isSidebarLink(a)&&uuidForLink(a));
  }
  function applyBulkFilter(){
    seedNativeIndex();
    const active=filtersActive();
    const term=normalized(bulkFilter.trim());
    const sidebar=document.getElementById("app-shell-sidebar")||
      document.querySelector("aside,[data-testid*='sidebar']");
    if(sidebar)sidebar.classList.toggle("cgs-search-active",active);
    let shown=0;
    for(const a of nativeSidebarRows()){
      const id=uuidForLink(a),name=originalTitle(a),imeno=profiles[id]?.imeno||"";
      const match=!active||!model||model.passes({uuid:id,title:name},
        profiles[id],states[id],modelFilters());
      a.classList.toggle("cgs-filter-hidden",!match);
      if(match)shown++;
      const box=a.querySelector(".cgs-bulk-check");
      if(box)box.checked=bulkSelected.has(id);
      // Foreign checkbox belongs to Bulk Delete: never synthesize clicks here.
    }
    renderFilterResults();
    if(bulkPanel){
      const state=chatIndex?.snapshot();
      const matches=active?filteredItems().length:shown;
      const summary=active
        ? matches+" wyników · "+(state?.size||shown)+" w indeksie"+
          (state?.loading?" · doczytuję…":state?.complete?" · pełny indeks":
           state?.loaded?" · indeks częściowy":" · lista widoczna")
        : shown+" widocznych";
      bulkPanel.querySelector(".cgs-bulk-counter").textContent=
        bulkSelected.size+" zaznaczonych · "+summary;
      const notice=bulkPanel.querySelector(".cgs-index-warning");
      if(notice){
        notice.textContent=active && state?.error
          ?"Niepełny indeks: "+state.error:"";
        notice.hidden=!notice.textContent;
      }
    }
  }
  const externalCheckboxes=new WeakSet();
  function externalBulkCheckbox(a){
    const row=a.closest("[data-sidebar-archive-chatgpt-id][role='group']")||
      a.closest("[role='group']")||a.parentElement;
    return row?.querySelector("input.conversation-checkbox")||null;
  }
  function addBulkCheckbox(a){
    if(a.closest("#cgs-filter-results"))return;
    const id=uuidForLink(a);
    if(!id)return;
    const external=externalBulkCheckbox(a);
    if(external){
      a.querySelector(".cgs-bulk-check")?.remove();
      if(!externalCheckboxes.has(external)){
        externalCheckboxes.add(external);
        external.addEventListener("change",()=>{
          if(external.checked)bulkSelected.add(id);
          else bulkSelected.delete(id);
          logAction("selection","Bulk Delete checkbox",
            id+" "+(external.checked?"zaznaczono":"odznaczono"),[id]);
          applyBulkFilter();
        });
        external.style.minWidth="22px";external.style.minHeight="22px";
        external.title="Zaznaczenie współdzielone z ChatGPT Bulk Delete";
      }
      return;
    }
    if(a.querySelector(".cgs-bulk-check"))return;
    const checkbox=document.createElement("input");
    checkbox.type="checkbox";checkbox.className="cgs-bulk-check";
    checkbox.title="Zaznacz rozmowę";
    checkbox.setAttribute("aria-label","Zaznacz rozmowę");
    checkbox.checked=bulkSelected.has(id);
    checkbox.addEventListener("click",e=>e.stopPropagation());
    checkbox.addEventListener("pointerdown",e=>e.stopPropagation());
    checkbox.addEventListener("change",e=>{
      if(e.target.checked)bulkSelected.add(id);else bulkSelected.delete(id);
      applyBulkFilter();
    });
    a.prepend(checkbox);
  }
  const actionHistory=[];
  function logAction(event,action,detail="",uuids=[]){
    const entry={event,action,detail:String(detail).slice(0,1200),
      uuids:uuids.slice(0,250),selected:bulkSelected.size,
      version:browser.runtime.getManifest?.()?.version||globalThis.CGS_BUILD_INFO?.version||"unknown"};
    actionHistory.unshift({time:new Date().toLocaleTimeString("pl-PL"),
      event,action,detail:entry.detail});
    if(actionHistory.length>25)actionHistory.length=25;
    const log=document.querySelector("#cgs-action-log");
    if(log)log.replaceChildren(...actionHistory.map(x=>{
      const row=document.createElement("div");
      row.textContent=x.time+" · "+x.event+" · "+x.action+" · "+x.detail;
      return row;
    }));
    browser.runtime.sendMessage({type:"SUP_LOG_EVENT",...entry}).catch(()=>{});
  }
  function bulkNotice(message,error=false){
    if(bulkResult){bulkResult.textContent=message;bulkResult.dataset.error=error?"1":"0";}
    logAction(error?"error":"progress","bulk_status",message,[...bulkSelected]);
  }
  async function bulkImportant(value){
    const ids=[...bulkSelected];
    if(!ids.length||bulkBusy)return;
    if(!window.confirm("Ustawić important="+value+" dla "+ids.length+" rozmów?"))return;
    bulkBusy=true;
    let ok=0,failed=[];
    try{
      for(let i=0;i<ids.length;i++){
        const uuid=ids[i],profile=profiles[uuid];
        if(!profile){
          const fresh=await browser.runtime.sendMessage({
            type:"SUP_PROFILE_GET",uuids:[uuid],force:true});
          if(fresh?.items?.[0])profiles[uuid]=fresh.items[0];
        }
        const activeProfile=profiles[uuid]||{uuid,revision:0,important:null,imeno:null};
        try{
          const result=await browser.runtime.sendMessage({
            type:"SUP_PROFILE_UPDATE",uuid,field:"important",important:value,
            expected_revision:activeProfile.revision});
          if(!result?.ok)throw new Error(result?.error||"API error");
          ok++;
          profiles[uuid]={...activeProfile,important:value,
            revision:Number.isInteger(result.revision)?result.revision:
              typeof activeProfile.revision==="number"?activeProfile.revision+1:
              activeProfile.revision};
          logAction("result","important="+value,
            uuid+" zapisano, revision="+profiles[uuid].revision,[uuid]);
        }catch(e){
          failed.push(uuid+": "+(e.message||e));
          logAction("error","important="+value,uuid+": "+(e.message||e),[uuid]);
        }
        bulkNotice("important="+value+": "+(i+1)+"/"+ids.length+
          ", sukces "+ok+", błędy "+failed.length);
      }
      await refreshProfiles(true);
      applyBulkFilter();
      bulkNotice("important="+value+": wykonano "+ok+"/"+ids.length+
        ", błędy "+failed.length+(failed.length?" · "+failed.slice(0,2).join("; "):""),
        failed.length>0);
    }finally{bulkBusy=false;}
  }
  async function bulkOpenTabs(){
    const ids=[...bulkSelected];
    if(!ids.length||bulkBusy)return;
    if(ids.length>12&&!window.confirm("Otworzyć "+ids.length+" nowych kart?"))return;
    bulkBusy=true;
    try{
      let opened=0,failures=[];
      for(let i=0;i<ids.length;i+=20){
        const batch=ids.slice(i,i+20);
        const result=await browser.runtime.sendMessage({type:"SUP_OPEN_TABS",uuids:batch});
        opened+=result?.opened||0;
        failures.push(...(result?.failures||[]));
        if(!result?.ok&&!result?.failures?.length)
          failures.push("Partia "+(i/20+1)+": "+(result?.error||"brak odpowiedzi"));
        logAction(result?.ok?"result":"error","open_tabs",
          "partia "+(i/20+1)+" otwarto "+(result?.opened||0)+"/"+batch.length,batch);
        bulkNotice("Otwieranie kart: "+opened+"/"+ids.length+
          (failures.length?" · błędy "+failures.length:""),!!failures.length);
      }
      bulkNotice("Otwarto "+opened+"/"+ids.length+" kart."+
        (failures.length?" Błędy: "+failures.slice(0,3).join("; "):""),
        !!failures.length);
    }catch(e){bulkNotice("Otwieranie kart: "+(e.message||e),true);}
    finally{bulkBusy=false;}
  }
  function findArchiveMenuItem() {
    return [...document.querySelectorAll(
      "[role='menu'][data-state='open'] [role='menuitem'],[role='menuitem']"
    )].filter(visible).find(el=>{
      const label=(el.innerText||el.textContent||"").trim().toLowerCase();
      return /^(archiwizuj|archive|archive chat|move to archive)$/.test(label);
    });
  }
  async function waitUntil(predicate,timeoutMs=5000) {
    const until=Date.now()+timeoutMs;
    do {
      if(predicate())return true;
      await new Promise(resolve=>setTimeout(resolve,100));
    }while(Date.now()<until);
    return !!predicate();
  }
  async function archiveOneSidebar(uuid){
    const link=sidebarRows().find(a=>uuidForLink(a)===uuid &&
      !a.closest("#cgs-filter-results"));
    if(!link)throw new Error("Rozmowa nie jest załadowana w natywnym panelu");
    const row=link.closest("[data-sidebar-archive-chatgpt-id][role='group']")||
              link.closest("[role='group']");
    if(!row)throw new Error("Nie znaleziono wiersza rozmowy");
    const buttonSelector=[
      "button[aria-label='Działania na czacie']",
      "button[aria-label='Chat actions']",
      "button[aria-haspopup='menu']"
    ].join(",");
    let more=row.querySelector(buttonSelector);
    if(!more){
      row.dispatchEvent(new MouseEvent("mouseover",{bubbles:true,view:window}));
      await new Promise(resolve=>setTimeout(resolve,250));
      more=row.querySelector(buttonSelector);
    }
    if(!more)throw new Error("Nie znaleziono menu Działania na czacie");
    more.click();
    if(!await waitUntil(()=>!!findArchiveMenuItem(),2500))
      throw new Error("Nie znaleziono opcji Archiwizuj w menu rozmowy");
    const item=findArchiveMenuItem();
    item.click();
    // Do not report success merely because the menu item was clicked.
    const disappeared=await waitUntil(()=>
      ![...document.querySelectorAll("[data-sidebar-archive-chatgpt-id][role='group']")]
        .some(el=>el===row || el.getAttribute("data-sidebar-archive-chatgpt-id")===uuid),
      8000);
    if(!disappeared)
      throw new Error("Nie potwierdzono usunięcia rozmowy z listy po archiwizacji");
  }
  async function bulkArchive(){
    const ids=[...bulkSelected];
    if(!ids.length||bulkBusy)return;
    if(!window.confirm("Archiwizować "+ids.length+" rozmów w ChatGPT?"))return;
    bulkBusy=true;
    let archived=0,errors=[];
    try{
      for(let i=0;i<ids.length;i++){
        const uuid=ids[i];
        try{
          if(!chatIndex?.archiveChat)throw new Error("Brak obsługi API archiwizacji");
          await chatIndex.archiveChat(uuid);
          archived++;
          logAction("result","archive",uuid+" serwer potwierdził",[uuid]);
        }
        catch(e){errors.push(uuid+": "+(e.message||e));}
        bulkNotice("Archiwizacja "+(i+1)+"/"+ids.length+
          "; potwierdzono "+archived+"; błędy "+errors.length);
      }
      applyBulkFilter();
      bulkNotice("Potwierdzono archiwizację na serwerze "+archived+"/"+ids.length+"."+
        (errors.length?" "+errors.slice(0,2).join("; "):""),errors.length>0);
    }finally{bulkBusy=false;}
  }
  async function bulkWake(){
    const ids=[...bulkSelected];
    if(!ids.length||bulkBusy)return;
    if(!window.confirm("Dodać "+ids.length+
      " rozmów do kolejki zgłoszeń wybudzania w Pozór Nadzór?"))return;
    bulkBusy=true;
    let created=0,existing=0,errors=[];
    try{
      for(let i=0;i<ids.length;i+=100){
        const batch=ids.slice(i,i+100);
        const response=await browser.runtime.sendMessage({
          type:"SUP_WAKE_REQUEST",uuids:batch});
        if(!response?.ok){
          errors.push(response?.error||"Błąd zapisu kolejki");continue;
        }
        created+=response.queued||0;existing+=response.already||0;
        logAction("result","wake_request",
          "nowe="+(response.queued||0)+" istniejące="+(response.already||0),batch);
      }
      bulkNotice("Zgłoszenia wybudzania: "+created+" nowych, "+existing+
        " już zapisanych. Oczekują na obsługę przez Nadzór."+
        (errors.length?" Błędy: "+errors.join("; "):""),errors.length>0);
    }catch(e){bulkNotice("Wybudzanie: "+(e.message||e),true);}
    finally{bulkBusy=false;}
  }
  async function bulkMoveToProject(){
    const ids=[...bulkSelected],projectId=projectTarget;
    if(!ids.length||bulkBusy)return;
    const project=chatIndex?.projects().find(x=>x.id===projectId);
    if(!project){bulkNotice("Wybierz prawidłowy projekt.",true);return;}
    if(!window.confirm("Przenieść "+ids.length+" rozmów do projektu „"+
      project.name+"”?"))return;
    bulkBusy=true;
    let moved=0,errors=[];
    try{
      for(let i=0;i<ids.length;i++){
        const id=ids[i];
        try{
          await chatIndex.moveToProject(id,projectId);
          moved++;logAction("result","move_to_project",id+" → "+projectId,[id]);
        }catch(e){
          errors.push(id+": "+(e.message||e));
          if(/HTTP 429|HTTP 401|HTTP 403/.test(String(e.message||e)))break;
        }
        bulkNotice("Przenoszenie "+(i+1)+"/"+ids.length+
          " · potwierdzono "+moved+" · błędy "+errors.length);
        await new Promise(resolve=>setTimeout(resolve,350));
      }
      applyBulkFilter();
      bulkNotice("Przeniesiono i zweryfikowano "+moved+"/"+ids.length+
        " do „"+project.name+"”."+
        (errors.length?" "+errors.slice(0,2).join("; "):""),errors.length>0);
    }finally{bulkBusy=false;}
  }
  async function enqueueOneWake(){
    const uuid=currentUuid();
    if(!uuid||busy)return;
    busy=true;updateToolbar();
    try{
      const result=await browser.runtime.sendMessage({
        type:"SUP_WAKE_REQUEST",uuids:[uuid]});
      if(!result?.ok)throw new Error(result?.error||"Błąd zgłoszenia");
      toast(result.queued
        ?"Zgłoszono do kolejki wybudzania; oczekuje na Nadzór."
        :"Zgłoszenie już istnieje w kolejce Nadzoru.",false);
    }catch(e){toast("Wybudzanie: "+(e.message||e),true);}
    finally{busy=false;updateToolbar();}
  }
  function makeBulkPanel(){
    const sidebar=document.getElementById("app-shell-sidebar")||
      document.querySelector("aside,[data-testid*='sidebar']");
    if(!sidebar)return;
    if(bulkPanel?.isConnected){positionBulkPanel(sidebar,bulkPanel);return;}
    const panel=document.createElement("section");
    panel.id="cgs-bulk-panel";
    panel.setAttribute("aria-label","Filtr i operacje zbiorcze rozmów");

    const build=globalThis.CGS_BUILD_INFO||{};
    const buildLine=document.createElement("div");
    buildLine.className="cgs-build-label";
    buildLine.textContent=(build.name||"ChatGPT Supervisor Status")+
      " v"+(build.version||"nieznana")+" · "+
      (build.built_at_local||"brak daty kompilacji");
    buildLine.title="Kompilacja: "+(build.built_at_utc||"brak")+
      " | źródło: "+(build.build_kind||"nieznane");
    panel.append(buildLine);
    browser.runtime.sendMessage({type:"SUP_BUILD_STATUS"}).then(result=>{
      if(!buildLine.isConnected)return;
      if(result?.upToDate===false){
        buildLine.dataset.update="old";
        buildLine.textContent+=" · STARA (najnowsza v"+result.latest+")";
      }else if(result?.upToDate===true){
        buildLine.dataset.update="latest";
        buildLine.textContent+=" · aktualna";
      }else{
        buildLine.dataset.update="unknown";
        buildLine.title+=" | aktualność niezweryfikowana";
      }
    }).catch(()=>{buildLine.dataset.update="unknown";});

    const search=document.createElement("input");
    search.type="search";search.placeholder="Filtr: tytuł lub imeno…";
    search.className="cgs-bulk-search";search.value=bulkFilter;
    search.addEventListener("input",()=>{
      bulkFilter=search.value;filterResultLimit=100;
      applyBulkFilter();scheduleIndexLoad();
    });
    panel.append(search);
    function filterButtons(label,key,options){
      const line=document.createElement("div");
      line.className="cgs-filter-line";
      const heading=document.createElement("span");
      heading.className="cgs-filter-heading";
      heading.textContent=label;line.append(heading);
      const optionsWrap=document.createElement("div");
      optionsWrap.className="cgs-filter-options";
      line.append(optionsWrap);
      for(const [value,text] of options){
        const b=document.createElement("button");
        b.type="button";b.textContent=text;
        b.className="cgs-filter-choice";
        b.dataset.filterKey=key;b.dataset.filterValue=value;
        b.setAttribute("aria-pressed",String(bulkFilters[key]===value));
        b.addEventListener("click",()=>{
          bulkFilters[key]=value;filterResultLimit=100;
          for(const peer of line.querySelectorAll(".cgs-filter-choice"))
            peer.setAttribute("aria-pressed",
              String(peer.dataset.filterValue===value));
          logAction("click","filter_"+key,value,[...bulkSelected]);
          applyBulkFilter();scheduleIndexLoad();
        });
        optionsWrap.append(b);
      }
      panel.append(line);
    }
    filterButtons("Ważność","importance",[
      ["all","Wszystkie"],["important","★ Ważne"],
      ["unimportant","☆ Nieważne"],["unset","? Nieustalone"]]);
    filterButtons("Praca","work",[
      ["all","Wszystkie"],["working","Pracują"],
      ["waking","Wybudzane"],["notworking","Niepracujące"],
      ["attention","Wymagają reakcji"],["outside","Poza Nadzorem"]]);
    filterButtons("Ostatnia praca","sort",[
      ["updated","Domyślnie"],["work-desc","↓ Malejąco"],
      ["work-asc","↑ Rosnąco"]]);
    const counter=document.createElement("div");
    counter.className="cgs-bulk-counter";panel.append(counter);
    const actions=document.createElement("div");actions.className="cgs-bulk-buttons";
    function button(label,fn){
      const b=document.createElement("button");b.type="button";b.textContent=label;
      b.addEventListener("click",()=>{
        logAction("click",label,"button",[...bulkSelected]);
        try{const result=fn();if(result?.catch)result.catch(e=>
          logAction("error",label,String(e?.message||e),[...bulkSelected]));}
        catch(e){logAction("error",label,String(e?.message||e),[...bulkSelected]);}
      });actions.append(b);
    }
    button("Zaznacz widoczne",()=>{
      const ids=filtersActive()?filteredItems().map(item=>item.uuid):
        nativeSidebarRows().filter(a=>!a.classList.contains("cgs-filter-hidden")).map(uuidForLink);
      for(const id of ids)bulkSelected.add(id);
      applyBulkFilter();
    });
    button("Odznacz widoczne",()=>{
      const ids=filtersActive()?filteredItems().map(item=>item.uuid):
        nativeSidebarRows().filter(a=>!a.classList.contains("cgs-filter-hidden")).map(uuidForLink);
      for(const id of ids)bulkSelected.delete(id);
      applyBulkFilter();
    });
    button("Wyczyść wybór",()=>{bulkSelected.clear();applyBulkFilter();});
    button("Ustaw ★ ważne",()=>bulkImportant(1));
    button("Ustaw ☆ nieważne",()=>bulkImportant(0));
    button("Otwórz karty",bulkOpenTabs);
    button("Archiwizuj",bulkArchive);
    button("↻ Dodaj do wybudzania",bulkWake);
    button("Odśwież listę",()=>scheduleIndexLoad(true));
    panel.append(actions);
    const projectRow=document.createElement("div");
    projectRow.className="cgs-project-row";
    const projectSelect=document.createElement("select");
    projectSelect.className="cgs-project-select";
    projectSelect.setAttribute("aria-label","Projekt docelowy");
    const projectButton=document.createElement("button");
    projectButton.type="button";projectButton.textContent="Przenieś do projektu";
    projectButton.addEventListener("click",()=>{
      logAction("click","Przenieś do projektu",projectTarget,[...bulkSelected]);
      bulkMoveToProject().catch(e=>logAction("error","Przenieś do projektu",
        String(e?.message||e),[...bulkSelected]));
    });
    projectRow.append(projectSelect,projectButton);panel.append(projectRow);
    function updateProjectOptions(){
      const current=projectSelect.value||projectTarget;
      const projects=chatIndex?.projects()||[];
      const options=[new Option(projects.length?"Wybierz projekt…":
        "Brak projektów (odśwież)","")];
      for(const project of projects)options.push(new Option(project.name,project.id));
      projectSelect.replaceChildren(...options);
      projectSelect.value=projects.some(x=>x.id===current)?current:"";
      projectTarget=projectSelect.value;
      projectButton.disabled=!projectTarget;
    }
    projectSelect.addEventListener("change",()=>{
      projectTarget=projectSelect.value;projectButton.disabled=!projectTarget;
    });
    projectSelect.addEventListener("focus",()=>{
      chatIndex?.loadProjectList().then(updateProjectOptions);
    });
    updateProjectOptions();
    chatIndex?.loadProjectList().then(updateProjectOptions);
    bulkResult=document.createElement("div");
    bulkResult.className="cgs-bulk-result";
    bulkResult.setAttribute("aria-live","polite");panel.append(bulkResult);
    const warning=document.createElement("div");warning.className="cgs-index-warning";
    warning.hidden=true;panel.append(warning);
    const actionLog=document.createElement("details");
    actionLog.className="cgs-action-history";
    const actionSummary=document.createElement("summary");
    actionSummary.textContent="Dziennik kliknięć i wyników";
    const actionList=document.createElement("div");
    actionList.id="cgs-action-log";
    actionLog.append(actionSummary,actionList);panel.append(actionLog);
    const feedback=document.createElement("details");
    feedback.className="cgs-feedback";
    const feedbackTitle=document.createElement("summary");
    feedbackTitle.textContent="✎ Zgłoś uwagę / błąd";
    const feedbackInput=document.createElement("textarea");
    feedbackInput.placeholder="Opisz problem lub propozycję zmiany…";
    feedbackInput.maxLength=3000;
    feedbackInput.setAttribute("aria-label","Treść uwagi");
    const feedbackSend=document.createElement("button");
    feedbackSend.type="button";feedbackSend.textContent="Zapisz zgłoszenie";
    const feedbackStatus=document.createElement("div");
    feedbackStatus.className="cgs-feedback-status";
    feedbackStatus.setAttribute("role","status");
    feedbackSend.addEventListener("click",async()=>{
      logAction("click","feedback","Zapisz zgłoszenie");
      const message=feedbackInput.value.trim();
      if(message.length<3){feedbackStatus.textContent="Wpisz co najmniej 3 znaki.";return;}
      feedbackSend.disabled=true;
      try{
        const response=await browser.runtime.sendMessage({
          type:"SUP_FEEDBACK",message});
        if(!response?.ok)throw new Error(response?.error||"Nie zapisano uwagi");
        feedbackInput.value="";
        feedbackStatus.dataset.error="0";
        feedbackStatus.textContent="Zapisano lokalnie: "+response.id+
          ". Zgłoszenie nie zostało jeszcze wysłane do GitHub.";
        logAction("result","feedback","Zapisano "+response.id);
      }catch(e){
        feedbackStatus.dataset.error="1";
        feedbackStatus.textContent="Błąd zapisu: "+(e.message||e);
        logAction("error","feedback",String(e.message||e));
      }finally{feedbackSend.disabled=false;}
    });
    feedback.append(feedbackTitle,feedbackInput,feedbackSend,feedbackStatus);
    const dock=document.createElement("div");
    dock.id="cgs-feedback-dock";
    dock.style.width=Math.max(240,Math.min(390,
      sidebar.getBoundingClientRect().width-12))+"px";
    dock.append(feedback);
    document.body.append(dock);
    const updateDock=()=>{if(dock.isConnected)
      dock.style.width=Math.max(240,Math.min(390,
        sidebar.getBoundingClientRect().width-12))+"px";};
    window.addEventListener("resize",updateDock,{passive:true});
    bulkPanel=panel;sidebar.prepend(panel);
    positionBulkPanel(sidebar,panel);
    if(typeof ResizeObserver!=="undefined")new ResizeObserver(()=>{
      if(panel.isConnected)positionBulkPanel(sidebar,panel);
    }).observe(panel);
    applyBulkFilter();
  }

  function scan() {
    for (const a of document.querySelectorAll("a[href*='/c/']")) {
      if (!isSidebarLink(a)) continue;
      const id = uuidForLink(a);
      if (!id) continue;
      addBulkCheckbox(a);
      const item = states[id],profile=profiles[id];
      // Changing a text NODE leaves the native link, menu and ordering intact.
      showImeno(a,profile);
      const cls=classify(item);
      const important=profile && profile.important===1;
      const activity=important
        ? fileAgeColor((item && item.activity)||profileFileActivity(profile))
        : {fill:"rgba(128,136,146,0.025)",
           info:"important nie jest 1: bez dodatkowego monitoringu"};
      const leftRGB=STATUS_RGB[cls.color]||STATUS_RGB.gray;
      const leftAlpha=cls.color==="gray"?.12:cls.color==="muted"?.16:.38;
      const leftFill=rgba(leftRGB,leftAlpha);
      const key=cls.color+"|"+leftFill+"|"+activity.fill+"|"+
        (activity.minute ?? "?")+"|"+(important?1:0)+"|"+(profile?.imeno||"");
      if(a.dataset.cgsKey===key)continue;
      a.classList.remove(...STATUS_CLASSES);
      a.classList.add("cgs-status-link","cgs-"+cls.color);
      a.classList.toggle("cgs-important",important);
      a.style.setProperty("--cgs-left-fill",leftFill);
      a.style.setProperty("--cgs-right-fill",activity.fill);
      a.dataset.cgsKey=key;
      a.dataset.cgsStatus=item?item.status:"BRAK_W_BAZIE";
      a.dataset.cgsLabel=cls.label+" | "+activity.info+
        (important?" | ważny":"")+
        (profile?.imeno?" | imeno: "+profile.imeno:"");
    }
    applyBulkFilter();
    updateToolbar();
  }
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => {scanQueued=false; scan();}, 120);
  }
  const wheelBound=new WeakSet();
  function gentleWheel(sidebar){
    if(!sidebar||wheelBound.has(sidebar))return;
    wheelBound.add(sidebar);
    sidebar.addEventListener("wheel",event=>{
      if(event.ctrlKey||event.shiftKey||
        event.target.closest("#cgs-bulk-panel,#cgs-feedback-dock"))return;
      const scroll=event.target.closest("[data-app-action-sidebar-scroll]")||
        sidebar.querySelector("[data-app-action-sidebar-scroll]");
      if(!scroll)return;
      const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?
        Math.max(scroll.clientHeight,400):1);
      if(Math.abs(delta)<80)return; // retain natural precision scrolling
      event.preventDefault();
      scroll.scrollTop+=Math.sign(delta)*Math.min(38,Math.abs(delta)*.30);
    },{passive:false,capture:true});
  }
  function watchSidebar() {
    const sidebar=document.getElementById("app-shell-sidebar")||
      document.querySelector("aside,[data-testid*='sidebar']");
    gentleWheel(sidebar);
    const root = document.querySelector("nav,aside,[data-testid*='sidebar']");
    if (root === navRoot) return;
    if (navObserver) navObserver.disconnect();
    navRoot = root;
    if (root) {
      navObserver = new MutationObserver(queueScan);
      navObserver.observe(root,{childList:true,subtree:true});
    }
  }
  async function refresh(force) {
    if (loadRunning) return;
    loadRunning = true;
    try {
      const data = await browser.runtime.sendMessage({type:"SUP_STATUS_GET",force:!!force});
      if (data && data.states && typeof data.states === "object") {
        states = data.states;
        filterRenderRevision++;
        connected = data.connected === true;
        generatedAt = data.generated_at || "";
        scan();
      }
    } catch(e) {connected = false;}
    finally {loadRunning = false;}
  }
  function toast(message, error) {
    if (!toolbar) return;
    const node = toolbar.querySelector(".cgs-toast");
    node.textContent = message;
    node.dataset.error = error ? "1" : "0";
    node.hidden = false;
    logAction(error?"error":"result","single_status",message,[currentUuid()].filter(Boolean));
    clearTimeout(toast.timeout);
    toast.timeout = setTimeout(() => {node.hidden=true;}, 4500);
  }
  function composer() {
    return document.querySelector(
      "#prompt-textarea[contenteditable='true'], " +
      "div.ProseMirror[contenteditable='true'], " +
      "[data-testid='prompt-textarea'][contenteditable='true'], " +
      "textarea#prompt-textarea,textarea[data-testid='prompt-textarea']"
    );
  }
  async function saveProfileField(field,value) {
    const id=currentUuid(),profile=id && profiles[id];
    if (!id || !profile || busy)return;
    busy=true;updateToolbar();
    try{
      const result=await browser.runtime.sendMessage({
        type:"SUP_PROFILE_UPDATE",uuid:id,field,
        ...(field==="important"?{important:value}:{imeno:value}),
        expected_revision:profile.revision
      });
      if(!result || !result.ok)
        throw new Error((result&&result.error)||"Zapis niepotwierdzony");
      toast(field==="important"
        ? (value===1?"Oznaczono jako ważny.":"Oznaczono jako nieważny.")
        : "Zapisano imeno.",false);
      await refreshProfiles(true);
    }catch(e){
      toast("Imeno: "+(e.message||e),true);
      await refreshProfiles(true);
    }finally{busy=false;updateToolbar();}
  }
  function toggleImportance() {
    const id=currentUuid(),profile=id && profiles[id];
    if(!profile){toast("Brak danych profilu Neo4j.",true);return;}
    saveProfileField("important",profile.important===1?0:1);
  }
  function editImeno() {
    const id=currentUuid(),profile=id && profiles[id];
    if(!profile){toast("Brak danych profilu Neo4j.",true);return;}
    const value=window.prompt("Ustaw imeno rozmowy (1–120 znaków):",
                              profile.imeno||"");
    if(value===null)return;
    const imeno=value.trim();
    if(!imeno || imeno.length>120){toast("Imeno: wpisz 1–120 znaków.",true);return;}
    if(imeno===profile.imeno)return;
    saveProfileField("imeno",imeno);
  }
  function insertJoinPrompt() {
    const editor = composer();
    if (!editor) {toast("Nie znaleziono pola wpisywania wiadomości.",true);return;}
    editor.focus();
    if (editor instanceof HTMLTextAreaElement) {
      const begin = editor.selectionStart;
      const prefix = editor.value && !editor.value.endsWith("\n") ? "\n\n" : "";
      editor.setRangeText(prefix+JOIN_PROMPT,begin,editor.selectionEnd,"end");
      editor.dispatchEvent(new Event("input",{bubbles:true}));
    } else {
      const prior = (editor.innerText || "").trim();
      const content = (prior ? "\n\n" : "") + JOIN_PROMPT;
      const ok = document.execCommand("insertText",false,content);
      if (!ok) {toast("Nie udało się wkleić tekstu do edytora.",true);return;}
      editor.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:content}));
    }
    toast("Polecenie wstawione. Wyślij je w czacie.",false);
  }
  async function unsubscribe() {
    const id = currentUuid();
    if (!id || busy) return;
    const item = states[id];
    if (!classify(item).registered) {toast("Ten czat nie jest aktywny w Nadzorze.",true);return;}
    busy = true;
    updateToolbar();
    try {
      const result = await browser.runtime.sendMessage({type:"SUP_LEAVE",uuid:id});
      if (!result || result.ok !== true || !result.changed) throw new Error(result && result.error || "Nie potwierdzono wyrejestrowania");
      toast("Wyrejestrowano z Nadzoru.",false);
      await refresh(true);
    } catch(e) {toast("Wyrejestrowanie: "+(e.message||e),true);}
    finally {busy=false;updateToolbar();}
  }
  const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
  function visible(e) {
    return e && e.getClientRects().length>0 && getComputedStyle(e).visibility!=="hidden";
  }
  async function archiveViaChatGPT() {
    const id = currentUuid();
    if (!id || busy) return;
    busy = true;
    updateToolbar();
    try {
      // ChatGPT's own conversation-header menu contains "Archiwizuj".
      // It works even when the conversation sidebar is collapsed.
      const sidebar = document.getElementById("app-shell-sidebar");
      const sidebarRight = sidebar ? sidebar.getBoundingClientRect().right : 52;
      const header = [...document.querySelectorAll("button[aria-haspopup='menu']")].find(b => {
        if (!visible(b) || b.closest("#cgs-status-actions")) return false;
        const r = b.getBoundingClientRect();
        return r.top >= 0 && r.top < 85 &&
          r.left > sidebarRight + 4 && r.left < Math.min(window.innerWidth - 180, sidebarRight + 700) &&
          (b.textContent || "").trim().length > 2;
      });
      if (header) {
        header.click();
        await sleep(500);
        const archiveItem = [...document.querySelectorAll("[role='menuitem']")].filter(visible).find(x => {
          const s = (x.innerText || x.textContent || "").trim().toLowerCase();
          return s.includes("archiwizuj") || s.startsWith("archive");
        });
        if (archiveItem) {
          archiveItem.click();
          toast("Wybrano archiwizację w ChatGPT.",false);
          return;
        }
        header.click();
      }
      let links = [...document.querySelectorAll("a[href*='/c/']")];
      let link = links.find(a => isSidebarLink(a) && uuidForLink(a)===id);
      if (!link) {
        const toggle = document.querySelector(
          "button[aria-label*='Pokaż pasek boczny'], button[aria-label*='Open sidebar'], [data-testid='open-sidebar-button']"
        );
        if (toggle && visible(toggle)) {
          toggle.click();
          await sleep(500);
          links = [...document.querySelectorAll("a[href*='/c/']")];
          link = links.find(a => isSidebarLink(a) && uuidForLink(a)===id);
        }
      }
      if (!link) throw new Error("Nie znaleziono rozmowy w natywnym panelu ChatGPT.");
      let menuOpen = false;
      let node = link;
      for (let level=0; level<4 && node && !menuOpen; level++,node=node.parentElement) {
        const buttons = [...node.querySelectorAll("button,[role='button']")].filter(visible);
        const more = buttons.find(b => /more|options|więcej|opcje|menu|actions|działania na czacie/i.test(
          (b.getAttribute("aria-label")||"")+" "+(b.getAttribute("title")||"")+" "+(b.getAttribute("data-testid")||"")+" "+(b.id||"")));
        if (more) {more.click();menuOpen=true;break;}
      }
      if (!menuOpen) {
        link.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,button:2,buttons:2,view:window}));
      }
      await sleep(650);
      const items = [...document.querySelectorAll("[role='menuitem'],[data-radix-menu-content] button")].filter(visible);
      const target = items.find(x => {
        const label = (x.innerText||x.textContent||"").trim().toLowerCase();
        return label.includes("archiwizuj") || label.startsWith("archive") || label.startsWith("move to archive");
      });
      if (!target) throw new Error("Nie znaleziono polecenia Archiwizuj w menu ChatGPT.");
      target.click();
      toast("Wybrano archiwizację w interfejsie ChatGPT.",false);
    } catch(e) {toast("Archiwizacja: "+(e.message||e),true);}
    finally {busy=false;updateToolbar();}
  }
  function makeToolbar() {
    if (toolbar?.isConnected || !document.body) return;
    toolbar=null;
    const node = document.createElement("div");
    node.id = "cgs-status-actions";
    node.setAttribute("role","group");
    node.setAttribute("aria-label","Akcje Nadzoru i archiwizacji");
    const actions = [
      {id:"join",text:"+",title:"Zgłoś do Nadzoru: wstaw polecenie do czatu",callback:insertJoinPrompt},
      {id:"leave",text:"−",title:"Wyrejestruj z Nadzoru",callback:unsubscribe},
      {id:"important",text:"☆",title:"Oznacz czat jako ważny",callback:toggleImportance},
      {id:"wake",text:"↻",title:"Dodaj do wybudzania (zgłoszenie do Pozór Nadzór)",callback:enqueueOneWake},
      {id:"imeno",text:"✎",title:"Ustaw imeno",callback:editImeno},
      {id:"archive",text:"▣",title:"Archiwizuj rozmowę w ChatGPT",callback:archiveViaChatGPT}
    ];
    for(const action of actions){
      const b=document.createElement("button");
      b.type="button";b.className="cgs-action cgs-action-"+action.id;
      b.textContent=action.text;
      b.setAttribute("aria-label",action.title);b.title=action.title;
      b.addEventListener("click",e=>{
        e.preventDefault();e.stopPropagation();
        logAction("click","single_"+action.id,"toolbar",[currentUuid()].filter(Boolean));
        try{const result=action.callback();
          if(result?.catch)result.catch(err=>logAction("error",
            "single_"+action.id,String(err.message||err),[currentUuid()].filter(Boolean)));}
        catch(err){logAction("error","single_"+action.id,
          String(err.message||err),[currentUuid()].filter(Boolean));}
      });
      node.appendChild(b);
    }
    const msg=document.createElement("div");
    msg.className="cgs-toast";msg.hidden=true;
    msg.setAttribute("role","status");
    node.appendChild(msg);
    const legend=document.createElement("div");
    legend.className="cgs-legend";
    legend.setAttribute("aria-label","Legenda kolorów i oznaczeń");
    const colors=[
      ["#19b77b","Pracuje"],["#e2b438","Wybudzanie"],
      ["#ef535d","Wymaga reakcji"],["#4e9af1","Kończenie"],
      ["#37c2bd","Wyjaśnienie"],["#8b95a4","Poza nadzorem"],
      ["#f7c752","Złota górna linia = ważny"]
    ];
    for(const [color,label] of colors){
      const entry=document.createElement("span");
      const dot=document.createElement("i");dot.className="cgs-dot";
      dot.style.backgroundColor=color;
      entry.append(dot,document.createTextNode(label));legend.append(entry);
    }
    node.appendChild(legend);
    document.body.appendChild(node);
    toolbar=node;
    updateToolbar();
  }
  function updateToolbar() {
    if (!toolbar) return;
    const id=currentUuid();
    toolbar.hidden=!id;
    if (!id) return;
    const status=classify(states[id]);
    const join=toolbar.querySelector(".cgs-action-join");
    const leave=toolbar.querySelector(".cgs-action-leave");
    const archive=toolbar.querySelector(".cgs-action-archive");
    const wake=toolbar.querySelector(".cgs-action-wake");
    const star=toolbar.querySelector(".cgs-action-important");
    const edit=toolbar.querySelector(".cgs-action-imeno");
    const profile=profiles[id];
    join.disabled=busy || status.registered;
    leave.disabled=busy || !status.registered || !connected;
    archive.disabled=busy;
    wake.disabled=busy;
    star.disabled=busy || !profile;
    edit.disabled=busy || !profile;
    const important=profile && profile.important===1;
    star.textContent=important?"★":"☆";
    star.setAttribute("aria-pressed",important?"true":"false");
    star.title=important?"Ważny: kliknij, aby ustawić 0"
                        :"Kliknij, aby ustawić important=1";
    star.dataset.important=profile && profile.important!==null
                           ?String(profile.important):"null";
    edit.title=profile?.imeno?"Imeno: "+profile.imeno:"Ustaw imeno rozmowy";
    toolbar.dataset.registered=status.registered ? "1":"0";
  }
  function tick() {
    if (location.pathname!==lastPath) {lastPath=location.pathname;queueScan();}
    watchSidebar();
    makeBulkPanel();
    makeToolbar();
    scan();
    refreshProfiles(false);
    observeCurrentChat();
  }
  makeToolbar();
  watchSidebar();
  makeBulkPanel();
  scan();
  refresh(true);
  refreshProfiles(true);
  setInterval(tick,3000);
  setInterval(()=>refresh(false),15000);
  document.addEventListener("visibilitychange",()=>{
    if(!document.hidden){refresh(true);refreshProfiles(true);observeCurrentChat();if(filtersActive())scheduleIndexLoad();}
  });
})();