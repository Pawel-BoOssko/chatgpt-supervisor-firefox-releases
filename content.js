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
        queueScan();
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
    if(chatIndex)return chatIndex.search(bulkFilter,profiles);
    const term=normalized(bulkFilter.trim());
    return nativeSidebarRows().map(a=>({
      uuid:uuidForLink(a),title:originalTitle(a)
    })).filter(item=>normalized(item.title).includes(term)||
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
    const term=bulkFilter.trim();
    if(!term){container.hidden=true;container.replaceChildren();return;}
    container.hidden=false;
    const matches=filteredItems();
    const state=chatIndex?.snapshot();
    const signature=[term,filterResultLimit,state?.revision||0,
      [...bulkSelected].sort().join(","),matches.length].join("|");
    if(container.dataset.cgsSignature===signature)return;
    container.dataset.cgsSignature=signature;
    const fragment=document.createDocumentFragment();
    for(const item of matches.slice(0,filterResultLimit)){
      const row=document.createElement("div");
      row.className="cgs-result-row";
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
      if(!bulkFilter.trim())return;
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
      panel.offsetHeight||190)+10;
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
    const term=normalized(bulkFilter.trim());
    const sidebar=document.getElementById("app-shell-sidebar")||
      document.querySelector("aside,[data-testid*='sidebar']");
    if(sidebar)sidebar.classList.toggle("cgs-search-active",!!term);
    let shown=0;
    for(const a of nativeSidebarRows()){
      const id=uuidForLink(a),name=originalTitle(a),imeno=profiles[id]?.imeno||"";
      const match=!term||normalized(name).includes(term)||normalized(imeno).includes(term);
      a.classList.toggle("cgs-filter-hidden",!match);
      if(match)shown++;
      const box=a.querySelector(".cgs-bulk-check");
      if(box)box.checked=bulkSelected.has(id);
    }
    renderFilterResults();
    if(bulkPanel){
      const state=chatIndex?.snapshot();
      const matches=term?filteredItems().length:shown;
      const summary=term
        ? matches+" wyników · "+(state?.size||shown)+" w indeksie"+
          (state?.loading?" · doczytuję…":state?.complete?" · pełny indeks":
           state?.loaded?" · indeks częściowy":" · lista widoczna")
        : shown+" widocznych";
      bulkPanel.querySelector(".cgs-bulk-counter").textContent=
        bulkSelected.size+" zaznaczonych · "+summary;
      const notice=bulkPanel.querySelector(".cgs-index-warning");
      if(notice){
        notice.textContent=term && state?.error
          ?"Niepełny indeks: "+state.error:"";
        notice.hidden=!notice.textContent;
      }
    }
  }
  function addBulkCheckbox(a){
    if(a.closest("#cgs-filter-results")||a.querySelector(".cgs-bulk-check"))return;
    const id=uuidForLink(a);
    if(!id)return;
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
  function bulkNotice(message,error=false){
    if(bulkResult){bulkResult.textContent=message;bulkResult.dataset.error=error?"1":"0";}
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
        if(!profile){failed.push(uuid+": brak profilu");continue;}
        try{
          const result=await browser.runtime.sendMessage({
            type:"SUP_PROFILE_UPDATE",uuid,field:"important",important:value,
            expected_revision:profile.revision});
          if(!result?.ok)throw new Error(result?.error||"API error");
          ok++;bulkSelected.delete(uuid);
          profiles[uuid]={...profile,important:value,
            revision:typeof profile.revision==="number"?profile.revision+1:profile.revision};
        }catch(e){failed.push(uuid+": "+(e.message||e));}
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
      const result=await browser.runtime.sendMessage({type:"SUP_OPEN_TABS",uuids:ids});
      bulkNotice("Otwarto "+(result?.opened||0)+"/"+ids.length+" kart."+
        (result?.failures?.length?" Błędy: "+result.failures.slice(0,2).join("; "):""),
        !result?.ok);
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
        try{await archiveOneSidebar(uuid);archived++;bulkSelected.delete(uuid);chatIndex?.remove(uuid);}
        catch(e){errors.push(uuid+": "+(e.message||e));}
        bulkNotice("Archiwizacja "+(i+1)+"/"+ids.length+
          "; potwierdzono "+archived+"; błędy "+errors.length);
      }
      applyBulkFilter();
      bulkNotice("Zarchiwizowano i usunięto z panelu "+archived+"/"+ids.length+"."+
        (errors.length?" "+errors.slice(0,2).join("; "):""),errors.length>0);
    }finally{bulkBusy=false;}
  }
  function makeBulkPanel(){
    const sidebar=document.getElementById("app-shell-sidebar")||
      document.querySelector("aside,[data-testid*='sidebar']");
    if(!sidebar)return;
    if(bulkPanel?.isConnected){positionBulkPanel(sidebar,bulkPanel);return;}
    const panel=document.createElement("section");
    panel.id="cgs-bulk-panel";
    panel.setAttribute("aria-label","Filtr i operacje zbiorcze rozmów");
    const search=document.createElement("input");
    search.type="search";search.placeholder="Filtr: tytuł lub imeno…";
    search.className="cgs-bulk-search";search.value=bulkFilter;
    search.addEventListener("input",()=>{bulkFilter=search.value;filterResultLimit=100;applyBulkFilter();scheduleIndexLoad();});
    panel.append(search);
    const counter=document.createElement("div");
    counter.className="cgs-bulk-counter";panel.append(counter);
    const actions=document.createElement("div");actions.className="cgs-bulk-buttons";
    function button(label,fn){
      const b=document.createElement("button");b.type="button";b.textContent=label;
      b.addEventListener("click",fn);actions.append(b);
    }
    button("Zaznacz widoczne",()=>{
      const ids=bulkFilter.trim()?filteredItems().map(item=>item.uuid):
        nativeSidebarRows().filter(a=>!a.classList.contains("cgs-filter-hidden")).map(uuidForLink);
      for(const id of ids)bulkSelected.add(id);
      applyBulkFilter();
    });
    button("Odznacz widoczne",()=>{
      const ids=bulkFilter.trim()?filteredItems().map(item=>item.uuid):
        nativeSidebarRows().filter(a=>!a.classList.contains("cgs-filter-hidden")).map(uuidForLink);
      for(const id of ids)bulkSelected.delete(id);
      applyBulkFilter();
    });
    button("Wyczyść wybór",()=>{bulkSelected.clear();applyBulkFilter();});
    button("★ Ważne",()=>bulkImportant(1));
    button("☆ Nieważne",()=>bulkImportant(0));
    button("Otwórz karty",bulkOpenTabs);
    button("Archiwizuj",bulkArchive);
    button("Odśwież listę",()=>scheduleIndexLoad(true));
    panel.append(actions);
    bulkResult=document.createElement("div");
    bulkResult.className="cgs-bulk-result";
    bulkResult.setAttribute("aria-live","polite");panel.append(bulkResult);
    const warning=document.createElement("div");warning.className="cgs-index-warning";
    warning.hidden=true;panel.append(warning);
    bulkPanel=panel;sidebar.prepend(panel);
    positionBulkPanel(sidebar,panel);
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
  function watchSidebar() {
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
    if (toolbar || !document.body) return;
    const node = document.createElement("div");
    node.id = "cgs-status-actions";
    node.setAttribute("role","group");
    node.setAttribute("aria-label","Akcje Nadzoru i archiwizacji");
    const actions = [
      {id:"join",text:"+",title:"Zgłoś do Nadzoru: wstaw polecenie do czatu",callback:insertJoinPrompt},
      {id:"leave",text:"−",title:"Wyrejestruj z Nadzoru",callback:unsubscribe},
      {id:"important",text:"☆",title:"Oznacz czat jako ważny",callback:toggleImportance},
      {id:"imeno",text:"✎",title:"Ustaw imeno",callback:editImeno},
      {id:"archive",text:"▣",title:"Archiwizuj rozmowę w ChatGPT",callback:archiveViaChatGPT}
    ];
    for(const action of actions){
      const b=document.createElement("button");
      b.type="button";b.className="cgs-action cgs-action-"+action.id;
      b.textContent=action.text;
      b.setAttribute("aria-label",action.title);b.title=action.title;
      b.addEventListener("click",e=>{e.preventDefault();e.stopPropagation();action.callback();});
      node.appendChild(b);
    }
    const msg=document.createElement("div");
    msg.className="cgs-toast";msg.hidden=true;
    msg.setAttribute("role","status");
    node.appendChild(msg);
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
    const star=toolbar.querySelector(".cgs-action-important");
    const edit=toolbar.querySelector(".cgs-action-imeno");
    const profile=profiles[id];
    join.disabled=busy || status.registered;
    leave.disabled=busy || !status.registered || !connected;
    archive.disabled=busy;
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
    if(!document.hidden){refresh(true);refreshProfiles(true);observeCurrentChat();if(bulkFilter.trim())scheduleIndexLoad();}
  });
})();