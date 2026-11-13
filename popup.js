"use strict";
async function update(force=false) {
  const connection=document.getElementById("connection");
  const details=document.getElementById("details");
  try {
    const data=await browser.runtime.sendMessage({type:"SUP_STATUS_GET",force});
    connection.textContent=data.connected ? "Połączono z Nadzorem" : "Brak połączenia z lokalnym serwerem";
    connection.style.color=data.connected?"#19b77b":"#ef535d";
    details.textContent="Rekordy: "+(data.count||Object.keys(data.states||{}).length)
      +"\nOdczyt: "+(data.generated_at?new Date(data.generated_at).toLocaleString("pl-PL"):"brak")
      +(data.activity && data.activity.generated_at ? "\nSkan plików: "+new Date(data.activity.generated_at).toLocaleString("pl-PL") : "\nSkan plików: brak")
      +(data.activity && data.activity.folder_count ? "\nKatalogi: "+data.activity.folder_count+" | nieistniejące: "+((data.activity.counts||{}).DIRECTORY_NOT_FOUND||0) : "")
      +(data.error?"\nBłąd: "+data.error:"");
  }catch(e){
    connection.textContent="Błąd komunikacji rozszerzenia";
    details.textContent=String(e);
  }
}
document.getElementById("refresh").addEventListener("click",()=>update(true));
update();