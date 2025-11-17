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
      chrome.storage.local.get({ nearby_only_profiles: [] }, async (res) => {
        const existing = Array.isArray(res.nearby_only_profiles) ? res.nearby_only_profiles : [];
        const map = new Map();
        for(const e of existing){
          const k = e.id ? ('id:'+e.id) : ((e.name||'')+'||'+(e.age||''));
          map.set(k, e);
        }
        const toDownload = [];
        for(const p of incoming){
          const k = (p && p.id) ? ('id:'+p.id) : ((p && (p.name||''))+'||'+((p && p.age)||''));
          const merged = Object.assign({}, map.get(k) || {}, p, {ts: Date.now()});
          map.set(k, merged);
          // collect for download if there are images and not yet downloaded
          const imgs = Array.isArray(merged.images) && merged.images.length ? merged.images : (merged.image ? [merged.image] : []);
          const existingDownloaded = Array.isArray(merged.downloadedImages) ? merged.downloadedImages : [];
          const newImgs = imgs.filter(u => u && !existingDownloaded.includes(u));
          if(newImgs.length) toDownload.push({ key: k, profile: merged, images: newImgs });
        }
        const merged = Array.from(map.values()).slice(0, 5000);
        // persist merged immediately
        await new Promise(r=> chrome.storage.local.set({ nearby_only_profiles: merged }, r));

        // schedule downloads for new images (one folder per profile)
        for(const item of toDownload){
          try{
            await scheduleDownloadsForProfile(item.profile, item.images);
            // after scheduling, update profile.downloadedImages and persist
            const updated = Array.isArray(item.profile.downloadedImages) ? item.profile.downloadedImages.slice() : [];
            for(const u of item.images) if(!updated.includes(u)) updated.push(u);
            item.profile.downloadedImages = updated;
            // write back the single profile into storage map
            const all = await new Promise(res=> chrome.storage.local.get({ nearby_only_profiles: [] }, res));
            const list = Array.isArray(all.nearby_only_profiles) ? all.nearby_only_profiles : [];
            const idx = list.findIndex(x => ((x.id && x.id === item.profile.id) || (x.name === item.profile.name && x.age === item.profile.age)) );
            if(idx >= 0){ list[idx] = item.profile; } else { list.push(item.profile); }
            await new Promise(r=> chrome.storage.local.set({ nearby_only_profiles: list }, r));
          }catch(e){ console.warn('[nearby-only][bg] download scheduling failed for', item.profile && (item.profile.id || item.profile.name), e); }
        }
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

// Helper: sanitize a string to be a safe folder/filename
function sanitizeName(s){
  if(!s) return 'unknown';
  try{ let t = String(s).normalize('NFKD').replace(/\p{Diacritic}/gu, ''); t = t.replace(/[<>:\\"\/\|\?\*]/g, '_'); t = t.replace(/\s+/g, '_'); if(t.length>64) t = t.slice(0,64); return t; }catch(e){ return 'profile'; }
}

// Schedule downloads for a profile's images (uses chrome.downloads.download to save into a folder named after profile)
async function scheduleDownloadsForProfile(profile, images){
  if(!images || !images.length) return;
  const folder = profile.id ? ('id_' + sanitizeName(profile.id)) : sanitizeName(profile.name || ('profile_' + Date.now()));
  for(let i=0;i<images.length;i++){
    const url = images[i];
    try{
      // derive filename from URL or fallback to index
      let ext = 'jpg';
      try{ const parts = (url||'').split('?')[0].split('/'); const last = parts[parts.length-1] || ''; const maybe = last.split('.').pop(); if(maybe && maybe.length<=5) ext = maybe.replace(/[^a-zA-Z0-9]/g,'').toLowerCase() || 'jpg'; }catch(_){}
      const namePart = sanitizeName(profile.name || profile.id || ('img'+(i+1)));
      const filename = `${folder}/${namePart}_${i+1}.${ext}`;
      // use chrome.downloads to save the URL into the suggested filename (browser will handle cross-origin)
      chrome.downloads.download({ url: url, filename: filename, conflictAction: 'uniquify' }, (downloadId)=>{
        if(chrome.runtime.lastError) console.warn('[nearby-only][bg] downloads.download error', chrome.runtime.lastError.message);
        else console.debug('[nearby-only][bg] started download', downloadId, filename);
      });
    }catch(e){ console.warn('[nearby-only][bg] error scheduling download for', url, e); }
  }
}
