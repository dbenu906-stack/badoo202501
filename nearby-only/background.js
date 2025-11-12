// Minimal background service worker for nearby-only extension
// Receives batches from content script and persists deduplicated entries to storage

self.addEventListener('message', (ev) => {
  // noop for now
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  try{
    if(!msg) return;
    // Persist incoming profiles
    if(msg.type === 'nearby_only_profiles' && msg.profiles){
      const incoming = Array.isArray(msg.profiles) ? msg.profiles : [];
      chrome.storage.local.get({ nearby_only_profiles: [] }, (res) => {
        const existing = Array.isArray(res.nearby_only_profiles) ? res.nearby_only_profiles : [];
        const map = new Map();
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
      return;
    }

    // Face++ detection: detect faces for all stored profiles with images
    if(msg.type === 'facepp_detect_all'){
      // run asynchronously
      (async () => {
        try{
          const get = (keys) => new Promise(res => chrome.storage.local.get(keys, res));
          const store = (obj) => new Promise(res => chrome.storage.local.set(obj, res));
          const cfg = await get({ facepp: {}, nearby_only_profiles: [] });
          const facepp = cfg.facepp || {};
          const profiles = Array.isArray(cfg.nearby_only_profiles) ? cfg.nearby_only_profiles : [];
          if(!facepp || !facepp.key || !facepp.secret || !facepp.endpoint){
            console.warn('[nearby-only][bg] facepp keys not configured');
            return;
          }
          const endpoint = facepp.endpoint;
          const key = facepp.key;
          const secret = facepp.secret;
          const delay = (msg.cfg && msg.cfg.delay) ? msg.cfg.delay : 900;
          for(let i=0;i<profiles.length;i++){
            const p = profiles[i];
            if(!p || !p.image) continue;
            if(p.facepp && p.facepp.ts) continue; // already detected
            try{
              const body = new URLSearchParams();
              body.append('api_key', key);
              body.append('api_secret', secret);
              body.append('image_url', p.image);
              body.append('return_landmark', '0');
              body.append('return_attributes', 'none');
              const resp = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
              const json = await resp.json();
              profiles[i] = Object.assign({}, p, { facepp: { result: json, ts: Date.now() } });
              // persist after each result to avoid data loss
              await store({ nearby_only_profiles: profiles });
              console.debug('[nearby-only][bg] facepp saved for', p.id || p.name);
            }catch(e){ console.warn('[nearby-only][bg] facepp call failed for', p.id||p.name, e); }
            await new Promise(r => setTimeout(r, delay));
          }
        }catch(e){ console.warn('[nearby-only][bg] facepp_detect_all error', e); }
      })();
      return;
    }
  }catch(e){ console.warn('[nearby-only][bg] error', e); }
});
