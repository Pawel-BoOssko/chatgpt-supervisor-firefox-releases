"use strict";
/* Pure presentation rules: no ChatGPT API writes and no local storage. */
(function(root){
  const norm=value=>String(value||"").normalize("NFKD")
    .replace(/[\u0300-\u036f]/g,"").toLowerCase();
  const RED=new Set(["DO_ROTACJI","BRAK_ODPOWIEDZI","ZATRZYMANY","DO_DECYZJI"]);
  const BLUE=new Set(["KONIEC_OD_CZATU","POWIADOMIENIE_ZLECONE",
    "POWIADOMIENIE_ODEBRANE","EMOTKA_ZIELONA"]);
  const TEAL=new Set(["DO_WYJASNIENIA","PYTANIE_JSON_1","PYTANIE_JSON_2",
    "PYTANIE_JSON_3"]);
  const OUTSIDE=new Set(["","POZA","BRAK_W_BAZIE"]);
  function workGroup(item){
    const status=String(item?.status||"").toUpperCase();
    if(status==="PRACUJE")return "working";
    if(status.startsWith("WYBUDZENIE_")||item?.queue_pending)return "waking";
    if(RED.has(status))return "attention";
    if(BLUE.has(status))return "finishing";
    if(TEAL.has(status))return "clarifying";
    if(OUTSIDE.has(status))return "outside";
    return "inactive";
  }
  function importanceGroup(profile){
    if(profile?.important===1)return "important";
    if(profile?.important===0)return "unimportant";
    return "unset";
  }
  function lastWorkMs(item,profile){
    const times=[];
    const add=value=>{
      if(!value)return;
      const ms=Date.parse(value);
      if(Number.isFinite(ms))times.push(ms);
    };
    add(item?.activity?.last_modified);
    for(const folder of Array.isArray(profile?.folders)?profile.folders:[])
      add(folder?.file_last_modified_at);
    return times.length?Math.max(...times):null;
  }
  function passes(entry,profile,state,filters){
    const q=norm(filters.term||"").trim();
    if(q && !norm(entry.title).includes(q) &&
       !norm(profile?.imeno||"").includes(q))return false;
    if(filters.importance && filters.importance!=="all" &&
       importanceGroup(profile)!==filters.importance)return false;
    const work=workGroup(state);
    if(filters.work==="working" && work!=="working")return false;
    if(filters.work==="waking" && work!=="waking")return false;
    if(filters.work==="notworking" && ["working","waking"].includes(work))return false;
    if(filters.work==="attention" && work!=="attention")return false;
    if(filters.work==="outside" && work!=="outside")return false;
    return true;
  }
  function sorted(entries,profiles,states,filters){
    const list=entries.filter(entry=>passes(entry,profiles[entry.uuid],states[entry.uuid],filters));
    if(filters.sort==="work-desc"||filters.sort==="work-asc"){
      const direction=filters.sort==="work-desc"?-1:1;
      list.sort((a,b)=>{
        const at=lastWorkMs(states[a.uuid],profiles[a.uuid]);
        const bt=lastWorkMs(states[b.uuid],profiles[b.uuid]);
        if(at===null && bt!==null)return 1;
        if(bt===null && at!==null)return -1;
        if(at!==null && bt!==null && at!==bt)return direction*(at-bt);
        return (b.updated||0)-(a.updated||0)||
          String(a.title).localeCompare(String(b.title),"pl");
      });
    }else{
      list.sort((a,b)=>(b.updated||0)-(a.updated||0)||
        String(a.title).localeCompare(String(b.title),"pl"));
    }
    return list;
  }
  root.CGSFilterModel=Object.freeze({
    workGroup,importanceGroup,lastWorkMs,passes,sorted
  });
  if(typeof module!=="undefined"&&module.exports)
    module.exports=root.CGSFilterModel;
})(typeof globalThis!=="undefined"?globalThis:this);
