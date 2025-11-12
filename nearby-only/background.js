// Minimal background service worker for nearby-only extension
// Receives batches from content script and persists deduplicated entries to storage

self.addEventListener('message', (ev) => {
  // noop for now
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  try{
    if(!msg || msg.type !== 'nearby_only_profiles' || !msg.profiles) return;
    const incoming = Array.isArray(msg.profiles) ? msg.profiles : [];
    // load existing
    chrome.storage.local.get({ nearby_only_profiles: [] }, (res) => {
      const existing = Array.isArray(res.nearby_only_profiles) ? res.nearby_only_profiles : [];
      const map = new Map();
      // key by id if present else name||age
      for(const e of existing){
        const k = e.id ? ('id:'+e.id) : ((e.name||'')+'||'+(e.age||''));
        map.set(k, e);
      }
      for(const p of incoming){
        const k = (p && p.id) ? ('id:'+p.id) : ((p && (p.name||''))+'||'+((p && p.age)||''));
        map.set(k, Object.assign({}, map.get(k) || {}, p, {ts: Date.now()}));
      }
      const merged = Array.from(map.values()).slice(0, 5000);
      chrome.storage.local.set({ nearby_only_profiles: merged }, ()=>{ /* saved */ });
    });
  }catch(e){ console.warn('[nearby-only][bg] error', e); }
});
