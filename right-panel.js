"use strict";
(() => {
  if(globalThis.__cgsImenoRightPanelStarted)return;
  globalThis.__cgsImenoRightPanelStarted=true;
  const UUID_ROUTE=/\/c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\/|$)/i;
  const ACTIONS=[
    ["temporary","Czasowo niedostępny"],
    ["dead_exclude","Martwy — wyklucz"],
    ["dead_handover","Martwy — przekaż zadanie"],
    ["dead_close","Martwy — zamknij projekt"],
    ["restore","Przywróć"]
  ];
  const FOLDER_ACTIONS=new Set(["dead_handover","dead_close"]);
  let shell=null,body=null,statusLine=null,toggle=null;
  let activeUuid=null,activeUrl="",context=null,epoch=0,open=true,busy=false;
  let selectedKeys=new Set(),currentNote="";
  let initialContextRetryUuid=null,contextRetryTimer=null;
  const uuid=()=>(UUID_ROUTE.exec(location.pathname)||[])[1]?.toLowerCase()||null;
  const node=(tag,cls,txt)=>{
    const el=document.createElement(tag);
    if(cls)el.className=cls;
    if(txt!==undefined&&txt!==null)el.textContent=String(txt);
    return el;
  };
  const add=(parent,...children)=>{for(const c of children)if(c)parent.append(c);return parent;};
  const line=(parent,label,value)=>{
    if(value===undefined||value===null||value==="")return;
    const p=node("p","cgs-ir-line");
    add(p,node("strong",null,label+": "),node("span",null,value));
    parent.append(p);
  };
  const group=(title,parent=body)=>{
    const section=node("section","cgs-ir-section");
    section.append(node("h3",null,title));
    parent.append(section);
    return section;
  };
  const details=(label,parent)=>{
    const d=node("details","cgs-ir-detail");
    const s=node("summary",null,label);
    d.append(s);parent.append(d);
    return d;
  };
  const str=(value,fallback="brak danych")=>value===null||value===undefined||value===""?fallback:String(value);
  function setStatus(message,error=false){
    if(!statusLine)return;
    statusLine.textContent=message;
    statusLine.dataset.error=error?"yes":"no";
  }
  function ensureUI(){
    if(shell?.isConnected||!document.body)return;
    shell=node("div","",null);shell.id="cgs-imeno-right-shell";
    toggle=node("button","cgs-ir-toggle","IMENO ◀");
    toggle.type="button";toggle.title="Rozwiń lub zwiń prawy panel Imeno";
    toggle.setAttribute("aria-label","Rozwiń lub zwiń prawy panel Imeno");
    toggle.addEventListener("click",()=>{
      open=!open;applyExpanded();
      if(open&&activeUuid&&!context)void refresh(true);
    });
    const panel=node("aside","cgs-ir-panel");
    panel.setAttribute("aria-label","Imeno — kontekst bieżącej rozmowy");
    const heading=node("div","cgs-ir-header");
    const headingText=node("div","cgs-ir-header-title","Imeno · bieżący czat");
    const build=globalThis.CGS_BUILD_INFO||{};
    const buildText=node("small","cgs-ir-build",
      [build.name||"ChatGPT Supervisor Status",
       build.version||"wersja nieznana",
       build.built_at_local||build.build_time||"czas kompilacji nieznany"].join(" · "));
    const reload=node("button","cgs-ir-reload","Odśwież");
    reload.type="button";reload.addEventListener("click",()=>void refresh(true));
    heading.append(headingText,buildText,reload);
    const legacyDock=node("div","cgs-ir-chat-actions");
    statusLine=node("div","cgs-ir-status","Odczyt Imeno…");
    statusLine.setAttribute("role","status");
    body=node("div","cgs-ir-body");
    panel.append(heading,legacyDock,statusLine,body);
    shell.append(toggle,panel);
    document.body.append(shell);
    dockCurrentChatActions();
    applyExpanded();
  }
  function dockCurrentChatActions(){
    if(!shell)return;
    const old=document.getElementById("cgs-status-actions");
    const dock=shell.querySelector(".cgs-ir-chat-actions");
    const left=document.getElementById("cgs-bulk-panel");
    if(!old)return;
    // The legend describes the left chat list, not the current chat.
    const legend=old.querySelector(".cgs-legend");
    if(legend&&left){
      const target=left.querySelector(".cgs-data-health");
      if(target)target.after(legend);
      else left.prepend(legend);
    }
    if(dock&&!dock.contains(old))dock.append(old);
  }
  function applyExpanded(){
    if(!shell)return;
    shell.dataset.collapsed=open?"no":"yes";
    document.documentElement.classList.toggle("cgs-ir-open",open&&!shell.hidden);
    toggle.textContent=open?"IMENO ▶":"IMENO ◀";
    toggle.setAttribute("aria-expanded",open?"true":"false");
  }
  function renderOverview(c){
    const heading=group("Tożsamość i zadanie");
    line(heading,"Tytuł",str(c.title,"nieustalony"));
    line(heading,"UUID",c.uuid||activeUuid);
    line(heading,"Imeno",c.imeno);
    line(heading,"Projekt",Array.isArray(c.project_names)&&c.project_names.length?
      c.project_names.join(" · "):c.sidebar_project);
    line(heading,"Stan rozmowy",str(c.lifecycle_state,"brak danych"));
    line(heading,"W Nadzorze",c.monitoring_excluded?"Wykluczony":"Brak potwierdzenia wykluczenia");
    line(heading,"Rewizja",c.lifecycle_revision);
    const url=node("a","cgs-ir-url",location.href);
    url.href=location.href;url.rel="noreferrer noopener";url.target="_blank";
    add(heading,node("p","cgs-ir-caption","Pełny adres rozmowy (także projektowej):"),url);
    if(Array.isArray(c.identities)&&c.identities.length){
      const ids=details("Identyfikatory · "+c.identities.length,heading);
      for(const id of c.identities)line(ids,str(id.kind),str(id.value));
    }
    const descriptions=Array.isArray(c.work_descriptions)?c.work_descriptions:[];
    const work=group("Misja, temat i postęp");
    if(!descriptions.length)
      work.append(node("p","cgs-ir-muted","Brak potwierdzonego opisu zadania w ChatInventoryEvidence."));
    for(const [i,d] of descriptions.entries()){
      const block=descriptions.length>1?details("Opis "+(i+1),work):work;
      line(block,"Misja",d.mission);
      line(block,"Temat",d.topic);
      line(block,"Podsumowanie",d.summary);
      line(block,"Etap",d.stage);
      if(d.progress!==null&&d.progress!==undefined&&d.progress!==""){
        line(block,"Postęp",str(d.progress)+(String(d.progress).includes("%")?"":"%"));
        const number=Number(d.progress);
        if(Number.isFinite(number)&&number>=0&&number<=100){
          const meter=node("progress","cgs-ir-progress");
          meter.max=100;meter.value=number;block.append(meter);
        }
      }
      line(block,"Źródło dowodu",d.source_file);
      line(block,"Data inwentaryzacji",d.inventory_date);
    }
    if(c.evidence){
      const e=details("Pochodzenie danych",work);
      line(e,"Źródło",c.evidence.source);
      line(e,"Ostatnio widziany",c.evidence.last_seen);
      line(e,"Pochodzenie nazwy",c.evidence.name_source);
    }
  }
  function describeCaretaker(f){
    const owner=f.current_caretaker;
    if(f.owner_conflict)return "KONFLIKT: wielu przypisanych opiekunów";
    if(f.successor_confirmed)return "Potwierdzony następca / obecny opiekun: "+
      (owner?owner.kind+" "+owner.value:"nieustalony");
    if(owner)return "Potwierdzony obecny opiekun: "+owner.kind+" "+owner.value;
    if(f.caretaker_state==="needs_replacement")return "Nieaktywny — oczekuje przekazania";
    if(f.disposition==="archive_candidate")return "Kandydat do archiwizacji";
    return "Brak dowodu aktualnego opiekuna";
  }
  function observedFileState(f){
    if(!f.file_scanned_at)return "Brak potwierdzonego skanu folderu.";
    if(f.file_scan_status&&/error|failed|unavailable/i.test(f.file_scan_status))
      return "Ostatni skan zakończył się błędem — stan pracy nieznany.";
    const stamp=f.last_file_modified_at||f.last_file_change_detected_at;
    if(!stamp)return "Folder sprawdzony; brak potwierdzonej modyfikacji plików.";
    const delta=Date.now()-new Date(stamp).getTime();
    if(!Number.isFinite(delta))return "Nie można ustalić wieku ostatniej modyfikacji.";
    if(delta<0)return "Czas modyfikacji jest późniejszy niż zegar lokalny.";
    const mins=Math.floor(delta/60000);
    if(mins<10)return "Wykryto niedawną modyfikację plików ("+mins+" min temu).";
    if(mins<60)return "Modyfikacja plików "+mins+" min temu.";
    if(mins<720)return "Modyfikacja plików "+Math.floor(mins/60)+" godz. temu.";
    return "Brak modyfikacji plików przez co najmniej 12 godzin.";
  }
  function renderFolders(c){
    const folders=Array.isArray(c.folders)?c.folders:[];
    const section=group("Foldery i opiekunowie ("+folders.length+")");
    section.append(node("p","cgs-ir-muted",
      "Zaznaczenie folderu ma znaczenie tylko dla akcji „przekaż zadanie” i „zamknij projekt”."));
    if(!folders.length)section.append(node("p","cgs-ir-muted",
      "Brak potwierdzonych folderów powiązanych z tym UUID. Nie wnioskuję opiekuna z dat plików."));
    for(const f of folders){
      const wrap=node("article","cgs-ir-folder");
      const label=node("label","cgs-ir-folder-choice");
      const check=node("input");
      check.type="checkbox";check.value=str(f.key,"");
      check.checked=selectedKeys.has(check.value);
      check.disabled=!f.key;
      check.addEventListener("change",()=>{
        if(check.checked)selectedKeys.add(check.value);
        else selectedKeys.delete(check.value);
      });
      add(label,check,node("span",null,str(f.path,f.key)));
      wrap.append(label);
      line(wrap,"Host",f.host);
      line(wrap,"Status istnienia",f.inventory_status||"brak dowodu");
      line(wrap,"Ocena opieki",describeCaretaker(f));
      line(wrap,"Stan przeglądu",f.review_state);
      line(wrap,"Stan folderu",f.caretaker_state);
      line(wrap,"Sygnał pracy w plikach",observedFileState(f));
      wrap.append(node("p","cgs-ir-muted",
        "Modyfikacja plików nie dowodzi, że czat wykonuje teraz zadanie."));
      line(wrap,"Ostatnia zmiana merytoryczna (indeks)",f.last_substantive_change_at);
      line(wrap,"Pewność tego oszacowania",f.substantive_change_confidence);
      line(wrap,"Ostatni skan",f.file_scanned_at);
      line(wrap,"Ostatnia zmiana pliku",f.last_file_modified_at);
      line(wrap,"Wykryta zmiana pliku",f.last_file_change_detected_at);
      line(wrap,"Status skanera",f.file_scan_status);
      const related=Array.isArray(f.related_chats)?f.related_chats:[];
      if(related.length){
        const d=details("Inne powiązane czaty (nie oznacza opiekuna): "+related.length,wrap);
        for(const rel of related)line(d,rel.evidence_type||"Powiązanie",
          [rel.title,rel.linked_uuid,rel.is_this_chat?"(ten czat)":""].filter(Boolean).join(" · "));
      }
      const inventory=Array.isArray(f.inventory_chat_notes)?f.inventory_chat_notes:[];
      if(inventory.length){
        const d=details("Nieprzypisane opisy i dowody: "+inventory.length,wrap);
        for(const note of inventory)line(d,str(note.title,note.topic),
          [note.stage,note.inventory_date,note.uuid||"UUID niepotwierdzony"].filter(Boolean).join(" · "));
      }
      const history=Array.isArray(f.caretaker_history)?f.caretaker_history:[];
      if(history.length){
        const d=details("Historia opiekunów: "+history.length,wrap);
        for(const h of history){
          line(d,str(h.kind||h.action,"Zdarzenie"),
            [h.at,h.from_value,h.to_value,h.source].filter(Boolean).join(" · "));
        }
      }
      section.append(wrap);
    }
  }
  function renderTriage(c){
    const section=group("Porządkowanie rozmowy");
    section.append(node("p","cgs-ir-muted",
      "Decyzja dotyczy Imeno. Archiwizacja ChatGPT i fizyczne foldery pozostają bez zmian."));
    const noteLabel=node("label","cgs-ir-note-label","Opcjonalna notatka");
    const textarea=node("textarea","cgs-ir-note");
    textarea.rows=2;textarea.maxLength=1000;
    textarea.placeholder="Powód decyzji (opcjonalnie)";
    textarea.value=currentNote;textarea.addEventListener("input",()=>{currentNote=textarea.value;});
    noteLabel.append(textarea);section.append(noteLabel);
    const actions=node("div","cgs-ir-actions");
    for(const [action,label] of ACTIONS){
      const b=node("button","cgs-ir-action cgs-ir-"+action,label);
      b.type="button";b.disabled=busy;
      b.addEventListener("click",()=>void triage(action));
      actions.append(b);
    }
    section.append(actions);
    const cleanup=c.nadzor_cleanup;
    if(cleanup?.status==="pending")
      section.append(node("p","cgs-ir-warning","Nadzór: wyrejestrowanie nadal oczekuje."));
  }
  function render(){
    if(!body)return;
    body.replaceChildren();
    if(!activeUuid)return;
    if(!context){
      body.append(node("p","cgs-ir-muted",
        "Dane Imeno nie zostały pobrane. UUID poniżej pochodzi z adresu ChatGPT, a nie z potwierdzonego odczytu Imeno."));
      line(body,"UUID z adresu",activeUuid);
      return;
    }
    const c=context;
    renderOverview(c);
    renderFolders(c);
    renderTriage(c);
  }
  async function refresh(force=false){
    if(document.hidden||busy)return;
    const uid=uuid();
    if(!uid)return;
    const startEpoch=epoch;
    activeUuid=uid;
    ensureUI();
    if(contextRetryTimer){clearTimeout(contextRetryTimer);contextRetryTimer=null;}
    setStatus("Odczyt kontekstu z Imeno…");
    try{
      const data=await browser.runtime.sendMessage({type:"SUP_CONTEXT_GET",uuid:uid,force:!!force});
      if(document.hidden||startEpoch!==epoch||uid!==uuid())return;
      if(!data?.ok){
        context=null;render();
        const reason=String(data?.error||"brak odpowiedzi");
        setStatus("Imeno: "+(/abort/i.test(reason)?"przerwano odczyt":reason),true);
        // One bounded retry after the first transient startup failure, never polling.
        if(initialContextRetryUuid!==uid&&/abort|timeout|failed to fetch/i.test(reason)){
          initialContextRetryUuid=uid;
          contextRetryTimer=setTimeout(()=>{
            contextRetryTimer=null;
            if(!document.hidden&&uuid()===uid&&epoch===startEpoch)void refresh(true);
          },1300);
        }
        return;
      }
      context=data;
      initialContextRetryUuid=null;
      const valid=new Set((data.folders||[]).map(f=>f.key));
      selectedKeys=new Set([...selectedKeys].filter(key=>valid.has(key)));
      render();
      setStatus("Imeno: odczytano kontekst · rewizja "+str(data.lifecycle_revision,"?"));
    }catch(e){
      if(!document.hidden&&startEpoch===epoch){
        context=null;render();setStatus("Błąd Imeno: "+(e.message||e),true);
      }
    }
  }
  async function triage(action){
    const uid=uuid();
    if(document.hidden||busy||!uid||!context)return;
    const folderAction=FOLDER_ACTIONS.has(action);
    const folders=(context.folders||[]).filter(f=>selectedKeys.has(f.key));
    if(folderAction&&!folders.length){
      setStatus("Wybierz co najmniej jeden potwierdzony folder.",true);return;
    }
    const paths=folders.map(f=>f.path||f.key);
    const choice=ACTIONS.find(a=>a[0]===action)?.[1]||action;
    const message=[
      "Zatwierdzić decyzję Imeno: "+choice+"?",
      "Rozmowa: "+str(context.title,uid),
      "UUID: "+uid,
      "Pełny URL: "+location.href,
      "Foldery: "+(paths.length?paths.join("; "):"brak — folders=[]"),
      "Pliki i rozmowy nie zostaną fizycznie usunięte.",
      "Archiwizacja ChatGPT jest osobną operacją."
    ].join("\n");
    if(!window.confirm(message))return;
    busy=true;render();setStatus("Zapis decyzji w Imeno…");
    const startEpoch=epoch;
    const payload={
      type:"SUP_TRIAGE",uuid:uid,action,
      expected_revision:Number(context.lifecycle_revision||0),
      folders:folderAction?folders.map(f=>({
        key:f.key,expected_review_revision:Number(f.review_revision||0),
        expected_caretaker_revision:Number(f.caretaker_revision||0)
      })):[],
      note:currentNote.slice(0,1000)
    };
    try{
      const result=await browser.runtime.sendMessage(payload);
      if(document.hidden||epoch!==startEpoch||uuid()!==uid)return;
      if(result?.ok){
        selectedKeys.clear();
        const cleanup=result.nadzor_cleanup?.status;
        const state=cleanup==="pending"?"Nadzór: oczekuje na synchronizację":
          cleanup==="ok"?"Nadzór: potwierdzone":"Nadzór: niezależny stan";
        busy=false;
        await refresh(true);
        setStatus("Imeno: "+(result.status||"zapisano")+" · "+state,cleanup==="pending");
      }else{
        const conflict=result?.http_status===409||result?.conflict||
          /conflict|revision|successor/i.test(String(result?.status||result?.error||""));
        busy=false;
        await refresh(true);
        setStatus(conflict?"Konflikt rewizji — kontekst pobrany ponownie. Sprawdź dane i wybór.":
          "Nie zapisano: "+str(result?.error,result?.status),true);
      }
    }catch(e){
      if(!document.hidden&&epoch===startEpoch)
        setStatus("Zapis nieudany: "+(e.message||e),true);
    }finally{
      busy=false;
      if(!document.hidden&&epoch===startEpoch&&context)render();
    }
  }
  function checkRoute(force=false){
    if(document.hidden)return;
    const id=uuid();
    if(!id){
      if(shell)shell.hidden=true;
      document.documentElement.classList.remove("cgs-ir-open");
      activeUuid=null;activeUrl="";context=null;return;
    }
    ensureUI();if(!shell)return;
    dockCurrentChatActions();
    shell.hidden=false;
    applyExpanded();
    if(id!==activeUuid){
      epoch++;activeUuid=id;activeUrl=location.href;context=null;selectedKeys.clear();currentNote="";
      render();void refresh(true);
    }else if(activeUrl!==location.href){
      // Same UUID in a project/non-project URL: update link without unnecessary Imeno read.
      activeUrl=location.href;
      render();
    }else if(force)void refresh(true);
  }
  function navigateSoon(){
    setTimeout(()=>checkRoute(false),0);
    setTimeout(()=>checkRoute(false),180);
  }
  document.addEventListener("visibilitychange",()=>{
    epoch++;
    if(contextRetryTimer){clearTimeout(contextRetryTimer);contextRetryTimer=null;}
    if(document.hidden){
      if(shell)shell.hidden=true;
      document.documentElement.classList.remove("cgs-ir-open");
    }else checkRoute(true);
  });
  window.addEventListener("popstate",navigateSoon);
  window.addEventListener("hashchange",navigateSoon);
  window.addEventListener("pageshow",()=>checkRoute(false));
  document.addEventListener("cgs:toolbar-ready",()=>dockCurrentChatActions());
  window.navigation?.addEventListener?.("navigatesuccess",navigateSoon);
  document.addEventListener("click",event=>{
    if(event.target.closest?.("a[href*='/c/']"))navigateSoon();
  },true);
  checkRoute(false);
})();
