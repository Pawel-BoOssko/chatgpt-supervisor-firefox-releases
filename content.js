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
  function scan() {
    for (const a of document.querySelectorAll("a[href*='/c/']")) {
      if (!isSidebarLink(a)) continue;
      const id = uuidForLink(a);
      if (!id) continue;
      const item = states[id];
      const cls = classify(item);
      const activity = fileAgeColor(item && item.activity);
      const leftRGB = STATUS_RGB[cls.color] || STATUS_RGB.gray;
      const leftAlpha = cls.color==="gray" ? .12 : cls.color==="muted" ? .16 : .38;
      const leftFill = rgba(leftRGB,leftAlpha);
      const key = cls.color+"|"+leftFill+"|"+activity.fill+"|"+(activity.minute ?? "?");
      if (a.dataset.cgsKey === key) continue;
      a.classList.remove(...STATUS_CLASSES);
      a.classList.add("cgs-status-link","cgs-" + cls.color);
      a.style.setProperty("--cgs-left-fill",leftFill);
      a.style.setProperty("--cgs-right-fill",activity.fill);
      a.dataset.cgsKey = key;
      a.dataset.cgsStatus = item ? item.status : "BRAK_W_BAZIE";
      a.dataset.cgsLabel = cls.label+" | "+activity.info;
    }
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
    join.disabled=busy || status.registered;
    leave.disabled=busy || !status.registered || !connected;
    archive.disabled=busy;
    toolbar.dataset.registered=status.registered ? "1":"0";
  }
  function tick() {
    if (location.pathname!==lastPath) {lastPath=location.pathname;queueScan();}
    watchSidebar();
    makeToolbar();
    scan();
  }
  makeToolbar();
  watchSidebar();
  scan();
  refresh(true);
  setInterval(tick,3000);
  setInterval(()=>refresh(false),15000);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)refresh(true);});
})();