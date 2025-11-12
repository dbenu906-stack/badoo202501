// Minimal service worker file for Manifest V3.
// This extension performs extraction from the popup using chrome.scripting,
// so no heavy background logic is required. This file exists to satisfy MV3.

chrome.runtime.onInstalled.addListener(() => {
  // no-op for now
});

// Receive scraped nearby profiles from the content script and persist them
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try{
    if(message && message.type === 'nearby_profiles' && Array.isArray(message.profiles)){
      const incoming = message.profiles.map(p => ({ name: p.name||'', image: p.image||'', ts: Date.now() }));
      chrome.storage.local.get({nearby_profiles: []}, data => {
        const existing = Array.isArray(data.nearby_profiles) ? data.nearby_profiles : [];
        // merge and dedupe by image+name
        const map = new Map();
        // keep existing first (older)
        for(const e of existing){ map.set((e.image||'')+'||'+(e.name||''), e); }
        for(const n of incoming){ map.set((n.image||'')+'||'+(n.name||''), n); }
        const merged = Array.from(map.values()).sort((a,b)=> (b.ts||0) - (a.ts||0));
        // limit to last 2000 entries
        const limited = merged.slice(0, 2000);
        chrome.storage.local.set({nearby_profiles: limited}, ()=>{
          console.debug('Saved nearby_profiles, count=', limited.length, 'from', incoming.length);
          sendResponse({saved: limited.length});
        });
        // indicate async response
        return true;
      });
      // indicate we'll call sendResponse asynchronously
      return true;
    }
  }catch(e){ console.warn('onMessage error', e); }
});
