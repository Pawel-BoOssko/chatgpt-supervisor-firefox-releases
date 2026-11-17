"use strict";
/* Manual DOM slimming based on ChatGPT Lag and Freezing Fix 1.5.7 / 1.5.
 * No observers, polling, telemetry, backend requests or auto-pruning.
 * Reloading ChatGPT restores the rendered conversation from the server.
 */
(()=>{
  if(globalThis.CGS_DOM_CLEANER)return;
  const TURN_SELECTOR='[data-testid^="conversation-turn-"]';
  const MARKER_ATTRIBUTE="data-cgs-dom-cleaner-marker";
  const KEEP_LAST=80;
  const MIN_EXTRA=10;
  let running=false;

  const info=(reason,other={})=>({ok:false,reason,removed:0,kept:0,...other});
  const isConversation=()=>/^\/(?:c\/[0-9a-f-]{36}|g\/g-p-[^/]+\/c\/[0-9a-f-]{36})\/?$/i
    .test(location.pathname)&&location.hostname==="chatgpt.com";

  function currentTurns(main){
    // Only top-level turns; nested copies are not independent messages.
    return [...main.querySelectorAll(TURN_SELECTOR)].filter(turn=>
      !turn.parentElement?.closest(TURN_SELECTOR));
  }
  function composer(){
    return document.querySelector(
      '#prompt-textarea,textarea[data-testid="prompt-textarea"],'+
      'div.ProseMirror[contenteditable="true"],'+
      '[contenteditable="true"][role="textbox"],[data-testid="composer"]');
  }
  function generating(){
    const selectors=[
      'button[data-testid*="stop"]',
      'button[aria-label*="Stop generating"]',
      'button[aria-label*="Zatrzymaj generowanie"]',
      'button[aria-label*="Zatrzymaj odpowiedź"]',
      '[data-testid="composer"] [aria-busy="true"]',
      'main [aria-busy="true"]'
    ];
    return selectors.some(sel=>!!document.querySelector(sel)) ||
      [...document.querySelectorAll("button")].some(button=>{
        if(button.disabled)return false;
        const label=(button.getAttribute("aria-label")||"")+" "+
                    (button.getAttribute("title")||"");
        return /stop generating|stop response|zatrzymaj generowanie|zatrzymaj odpowiedź|przerwij generowanie/i
          .test(label);
      });
  }
  function clean({keepLast=KEEP_LAST}={}){
    if(running)return info("already_running");
    if(globalThis.CGS_COORDINATOR_ACTIVE===false||document.hidden)
      return info("inactive_tab");
    if(!isConversation())return info("not_conversation");
    const main=document.querySelector("main");
    if(!main)return info("main_missing");
    if(!composer())return info("composer_missing");
    if(generating())return info("generation_active");
    const count=Number(keepLast);
    if(!Number.isInteger(count)||count<20||count>300)
      return info("invalid_keep_last");
    running=true;
    try{
      const turns=currentTurns(main);
      if(turns.length<count+MIN_EXTRA)
        return {ok:true,skipped:true,reason:"not_enough_turns",removed:0,
                kept:turns.length,keepLast:count};
      const candidates=turns.slice(0,turns.length-count);
      const focused=document.activeElement;
      // Preserve any turn containing the focused element or active editor.
      const removable=candidates.filter(turn=>turn.isConnected &&
        (!focused||!turn.contains(focused)) && !turn.contains(composer()));
      if(!removable.length)return info("nothing_to_remove",{kept:turns.length});
      const before=main.getElementsByTagName("*").length;
      const parents=new Map();
      for(const node of removable){
        const parent=node.parentNode;
        if(!parent)continue;
        if(!parents.has(parent))parents.set(parent,[]);
        parents.get(parent).push(node);
      }
      let removed=0,markers=0;
      for(const [parent,nodes] of parents){
        // Insert only one compact marker per sibling container.
        const marker=document.createElement("div");
        marker.setAttribute(MARKER_ATTRIBUTE,"1");
        marker.setAttribute("role","note");
        marker.textContent="Wyczyszczono starsze wiadomości w tym widoku. "+
          "Przeładuj stronę, aby je ponownie wyświetlić.";
        parent.insertBefore(marker,nodes[0]);
        markers++;
        for(const node of nodes){
          if(node.parentNode!==parent)continue;
          parent.removeChild(node);
          removed++;
        }
      }
      if(!removed)return info("nothing_removed",{kept:turns.length});
      const afterTurns=currentTurns(main).length;
      const after=main.getElementsByTagName("*").length;
      return {ok:true,removed,kept:afterTurns,markers,keepLast:count,
              elementsBefore:before,elementsAfter:after,
              elementsRemoved:Math.max(0,before-after)};
    }catch(error){
      return info("cleanup_failed",{message:String(error?.message||error).slice(0,160)});
    }finally{running=false;}
  }
  globalThis.CGS_DOM_CLEANER={clean,KEEP_LAST};
})();
