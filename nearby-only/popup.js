(function(){
  const $ = id => document.getElementById(id);
  const status = $('status');
  function setStatus(s){ status.textContent = s; }

  async function sendToActive(msg){
    try{
      const [tab] = await chrome.tabs.query({active:true,lastFocusedWindow:true});
      if(!tab) return setStatus('No active tab');
      chrome.tabs.sendMessage(tab.id, msg, async (resp)=>{
        if(chrome.runtime.lastError){
          const err = chrome.runtime.lastError.message || '';
          // common case: content script not injected on this tab/frame
          setStatus('No receiver: attempting to inject content script...');
          try{
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content-script.js'] });
            // give the script a short moment to initialize
            setTimeout(()=>{
              chrome.tabs.sendMessage(tab.id, msg, (resp2)=>{
                if(chrome.runtime.lastError) setStatus('Error after injection: ' + (chrome.runtime.lastError.message||''));
                else setStatus('Sent after injection: ' + (msg.type||''));
              });
            }, 350);
          }catch(e){
            setStatus('Injection failed: ' + (e && e.message ? e.message : e));
          }
        } else {
          setStatus('Sent: ' + (msg.type||''));
        }
      });
    }catch(e){ setStatus('send error: '+e); }
  }

  $('start').addEventListener('click', async ()=>{
    const usePointer = $('use-pointer').checked;
    setStatus('Starting auto-scroll...');
    await sendToActive({ type: 'start_nearby_only', cfg: { emulatePointer: usePointer } });
  });

  $('start-click').addEventListener('click', async ()=>{
    const usePointer = $('use-pointer').checked;
    setStatus('Starting click-and-scrape...');
    await sendToActive({ type: 'start_nearby_click_and_scrape', cfg: { emulatePointer: usePointer } });
  });

  $('stop').addEventListener('click', async ()=>{
    setStatus('Stopping...');
    await sendToActive({ type: 'stop_nearby_only' });
  });

  $('export').addEventListener('click', async ()=>{
    // Export CSV + images as a ZIP. Images are fetched and stored in the zip alongside a CSV.
    chrome.storage.local.get({ nearby_only_profiles: [] }, async (res)=>{
      const arr = Array.isArray(res.nearby_only_profiles) ? res.nearby_only_profiles : [];
      if(!arr.length) return setStatus('No profiles to export');
      setStatus('Fetching images...');
      const files = [];
      let idx = 0;
      const nameCounts = Object.create(null);
      const sanitizeFilename = (s) => {
        if(!s) return '';
        // remove path separators, control chars; keep letters, numbers, dash, underscore, space
        let t = String(s).normalize('NFKD').replace(/\p{Diacritic}/gu, '');
        t = t.replace(/[^\p{L}\p{N} _-]/gu, '');
        t = t.replace(/\s+/g, '_');
        if(t.length > 48) t = t.slice(0,48);
        return t || '';
      };
      for(const p of arr){
        idx++;
        // prefer a larger candidate when available: use images[] if present, otherwise p.image
        const url = getBestImageUrl(p) || '';
        // prefer profile id for filename, otherwise sanitized name, otherwise fallback to index
        let base = '';
        if(p.id) base = `id_${sanitizeFilename(p.id)}`;
        if(!base && p.name) base = sanitizeFilename(p.name);
        if(!base) base = `profile_${idx}`;
        // avoid duplicates
        const seen = nameCounts[base] || 0; nameCounts[base] = seen + 1;
        const finalBase = seen ? `${base}_${seen+1}` : base;
        const ext = (url.split('?')[0].split('.').pop() || 'jpg').slice(0,6);
        const filename = `${finalBase}.${ext}`;
        const blob = await fetchAsBlob(url);
          if(blob){
            try{
              setStatus(`Processing image ${idx}/${arr.length}...`);
              const filter = document.getElementById('imgFilter')?.value || 'none';
              const processed = await processImageBlob(blob, filter);
              files.push({name: filename, data: processed});
            }catch(e){
              console.warn('processing failed, adding original', e);
              files.push({name: filename, data: blob});
            }
          } else { files.push({name: `${finalBase}_noimage.txt`, data: new Blob([`Failed to fetch: ${url}`], {type:'text/plain'})}); }
  }
      // add CSV summary
      const csv = toCSV(arr);
      files.push({name: 'profiles.csv', data: new Blob([csv], {type:'text/csv'})});
      setStatus('Creating ZIP...');
      const zipBlob = await createZipBlob(files);
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a'); a.href = url; a.download = 'nearby_profiles_with_images.zip'; a.click(); URL.revokeObjectURL(url);
      setStatus('Export started (' + arr.length + ' profiles)');
    });
  });

  function toCSV(arr){
    const cols = ['id','name','age','image','ts'];
    const rows = [cols.join(',')];
    for(const r of arr){
      const line = cols.map(c => '"'+String((r[c]||'')).replace(/"/g,'""')+'"').join(',');
      rows.push(line);
    }
    return rows.join('\n');
  }

  async function fetchAsBlob(url){
    try{
      if(!url) return null;
      if(url.startsWith('data:')){ const res = await fetch(url); return await res.blob(); }
      if(url.startsWith('//')) url = window.location.protocol + url;
      const res = await fetch(url, {mode:'cors'});
      if(!res.ok) return null; return await res.blob();
    }catch(e){ console.warn('fetchAsBlob failed', url, e); return null; }
  }

  // Attempt to return a higher-resolution image URL for a profile
  function getBestImageUrl(p){
    try{
      if(!p) return '';
      const candidates = [];
      if(Array.isArray(p.images) && p.images.length){
        for(const u of p.images) if(u) candidates.push(u);
      }
      if(p.image) candidates.push(p.image);
      if(!candidates.length) return '';
      // prefer the longest URL (heuristic for higher-res) after trying simple upscale transformations
      const transformed = candidates.map(u => ({orig:u, alt: tryExpandUrl(u)}));
      // pick the alt with the longest length
      transformed.sort((a,b)=> (b.alt||b.orig).length - (a.alt||a.orig).length);
      return transformed[0].alt || transformed[0].orig;
    }catch(e){ return p.image || ''; }
  }

  function tryExpandUrl(u){
    if(!u || typeof u !== 'string') return u;
    try{
      let url = u;
      // strip common thumbnail query params like ?size=200 or &width=200
      url = url.replace(/[?&](size|width|height)=[0-9]+/gi, '');
      // remove leftover trailing ? or &
      url = url.replace(/[?&]$/,'');
      // replace common path segments
      url = url.replace(/\/thumb\//i, '/');
      url = url.replace(/\/small\//i, '/original/');
      url = url.replace(/(?:_thumb|_small|\-thumb|\-small|thumb_|small_)/gi, '');
      // some CDNs use sXXX or wXXX tokens, try removing _sXXX or _wXXX before extension
      url = url.replace(/_s?\d+(?=\.)/i, '');
      return url;
    }catch(e){ return u; }
  }

  // Create a ZIP Blob from an array of {name, data: Blob}
  async function createZipBlob(files){
    // CRC32 table
    const crcTable = (()=>{ const table = new Uint32Array(256); for(let i=0;i<256;i++){ let c=i; for(let k=0;k<8;k++) c = ((c&1) ? (0xEDB88320 ^ (c>>>1)) : (c>>>1)); table[i]=c; } return table; })();
    const crc32 = (buf) => { let crc = 0 ^ (-1); for(let i=0;i<buf.length;i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF]; return (crc ^ (-1)) >>> 0; };
    const entries = [];
    for(const f of files){ const ab = await f.data.arrayBuffer(); const uint8 = new Uint8Array(ab); const crc = crc32(uint8); entries.push({name:f.name, data:uint8, crc, size:uint8.length}); }
    const textEncoder = new TextEncoder(); const parts = []; let offset = 0; const centralDir = [];
    for(const e of entries){ const nameBuf = textEncoder.encode(e.name);
      const localHeader = new Uint8Array(30 + nameBuf.length);
      const dv = new DataView(localHeader.buffer); let p=0;
      dv.setUint32(p, 0x04034b50, true); p+=4; dv.setUint16(p, 20, true); p+=2; dv.setUint16(p, 0, true); p+=2; dv.setUint16(p, 0, true); p+=2; dv.setUint16(p, 0, true); p+=2; dv.setUint16(p, 0, true); p+=2;
      dv.setUint32(p, e.crc, true); p+=4; dv.setUint32(p, e.size, true); p+=4; dv.setUint32(p, e.size, true); p+=4; dv.setUint16(p, nameBuf.length, true); p+=2; dv.setUint16(p, 0, true); p+=2;
      localHeader.set(nameBuf, 30);
      parts.push(localHeader); parts.push(e.data);
      const centralHeader = new Uint8Array(46 + nameBuf.length);
      const cdv = new DataView(centralHeader.buffer); p=0;
      cdv.setUint32(p, 0x02014b50, true); p+=4; cdv.setUint16(p, 0x14, true); p+=2; cdv.setUint16(p, 20, true); p+=2; cdv.setUint16(p, 0, true); p+=2; cdv.setUint16(p, 0, true); p+=2; cdv.setUint16(p, 0, true); p+=2; cdv.setUint16(p, 0, true); p+=2;
      cdv.setUint32(p, e.crc, true); p+=4; cdv.setUint32(p, e.size, true); p+=4; cdv.setUint32(p, e.size, true); p+=4; cdv.setUint16(p, nameBuf.length, true); p+=2; cdv.setUint16(p, 0, true); p+=2; cdv.setUint16(p, 0, true); p+=2; cdv.setUint16(p, 0, true); p+=2; cdv.setUint16(p, 0, true); p+=2; cdv.setUint32(p, 0, true); p+=4; cdv.setUint32(p, offset, true); p+=4;
      centralHeader.set(nameBuf, 46);
      centralDir.push(centralHeader);
      offset += localHeader.length + e.size;
    }
    const centralSize = centralDir.reduce((s,b)=>s + b.length, 0);
    const centralOffset = offset;
    const eocdr = new Uint8Array(22);
    const ev = new DataView(eocdr.buffer); let pp=0; ev.setUint32(pp, 0x06054b50, true); pp+=4; ev.setUint16(pp, 0, true); pp+=2; ev.setUint16(pp, 0, true); pp+=2; ev.setUint16(pp, entries.length, true); pp+=2; ev.setUint16(pp, entries.length, true); pp+=2; ev.setUint32(pp, centralSize, true); pp+=4; ev.setUint32(pp, centralOffset, true); pp+=4; ev.setUint16(pp, 0, true); pp+=2;
    const blobParts = [];
    for(const p of parts) blobParts.push(p instanceof Uint8Array ? p : new Uint8Array(p));
    for(const c of centralDir) blobParts.push(c instanceof Uint8Array ? c : new Uint8Array(c));
    blobParts.push(eocdr);
    return new Blob(blobParts, {type:'application/zip'});
  }

  // ---------------------- Image processing helpers ----------------------
  // Apply selected filter (none|grayscale|pixelate|blur) to an image Blob and return a processed Blob (PNG)
  async function processImageBlob(blob, filter){
    // If face anonymization is enabled in the UI, attempt to detect faces via face-api.js
    let faceRects = null;
    try{
      const enableFace = document.getElementById('faceppEnable')?.checked;
      if(enableFace && typeof faceapi !== 'undefined'){
        try{ faceRects = await detectFacesWithFaceApi(blob); }catch(e){ console.warn('Local face detection failed', e); }
      }
    }catch(e){ /* ignore */ }

    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = async () => {
        try{
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          // draw original image
          ctx.drawImage(img, 0, 0);

          // anonymize faces first
          if(faceRects && faceRects.length > 0){
            const method = document.getElementById('faceppMethod')?.value || 'pixelate';
            await applyFaceAnonymization(canvas, faceRects, method);
          }

          // apply global filter
          await applyGlobalFilter(canvas, filter || 'none');

          canvas.toBlob((b)=>{ if(b) resolve(b); else reject(new Error('toBlob failed')); }, 'image/png');
        }catch(err){ reject(err); }
      };
      img.onerror = (e)=> reject(new Error('Image load error'));
      const url = URL.createObjectURL(blob);
      img.crossOrigin = 'anonymous';
      img.src = url;
      img.addEventListener('load', ()=> URL.revokeObjectURL(url));
    });
  }

  // Local face detection using face-api.js and extension-local models (if available)
  async function detectFacesWithFaceApi(blob){
    if(typeof faceapi === 'undefined') throw new Error('face-api.js not loaded');
    // Attempt to load local models from extension (models/ folder)
    await ensureFaceApiModels();
    const img = await new Promise((res, rej)=>{
      const i = new Image(); const url = URL.createObjectURL(blob);
      i.onload = ()=>{ URL.revokeObjectURL(url); res(i); };
      i.onerror = (e)=>{ URL.revokeObjectURL(url); rej(e); };
      i.crossOrigin = 'anonymous'; i.src = url;
    });
    const detections = await faceapi.detectAllFaces(img, new faceapi.TinyFaceDetectorOptions({inputSize: 512, scoreThreshold: 0.5}));
    return detections.map(d=>({ x: Math.round(d.box.x), y: Math.round(d.box.y), width: Math.round(d.box.width), height: Math.round(d.box.height) }));
  }

  async function ensureFaceApiModels(modelPath='models'){
    if(typeof faceapi === 'undefined') throw new Error('face-api.js not loaded');
    if(window.__nearby_only_faceapi_loaded) return;
    const modelBaseLocal = chrome && chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL(modelPath) : modelPath;
    try{
      await faceapi.nets.tinyFaceDetector.loadFromUri(modelBaseLocal);
      window.__nearby_only_faceapi_loaded = true;
      return;
    }catch(localErr){
      console.warn('Local model load failed, trying remote fallback', localErr && localErr.message);
    }
    // fallback remote
    const fallback = 'https://justadudewhohacks.github.io/face-api.js/models';
    await faceapi.nets.tinyFaceDetector.loadFromUri(fallback);
    window.__nearby_only_faceapi_loaded = true;
  }

  // Apply anonymization to face rectangles on the given canvas
  async function applyFaceAnonymization(canvas, rects, method){
    const ctx = canvas.getContext('2d');
    for(const r of rects){
      const sx = r.x || r.left || 0;
      const sy = r.y || r.top || 0;
      const sw = r.width || r.w || 0;
      const sh = r.height || r.h || 0;
      if(sw <=0 || sh<=0) continue;
      if(method === 'pixelate'){
        const tmp = document.createElement('canvas');
        const scale = Math.max(2, Math.floor(Math.min(sw, sh) / 10));
        tmp.width = Math.max(1, Math.floor(sw / scale));
        tmp.height = Math.max(1, Math.floor(sh / scale));
        const tctx = tmp.getContext('2d');
        tctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, tmp.width, tmp.height);
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(sx, sy, sw, sh);
        ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, sx, sy, sw, sh);
        ctx.imageSmoothingEnabled = true;
      } else if(method === 'blur'){
        const tmp = document.createElement('canvas'); tmp.width = sw; tmp.height = sh;
        const tctx = tmp.getContext('2d');
        tctx.filter = 'blur(8px)';
        tctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
        ctx.clearRect(sx, sy, sw, sh);
        ctx.drawImage(tmp, 0, 0, sw, sh, sx, sy, sw, sh);
      }
    }
  }

  // Apply a global filter to the whole canvas
  async function applyGlobalFilter(canvas, filter){
    if(!filter || filter === 'none') return;
    const w = canvas.width, h = canvas.height;
    const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h;
    const tctx = tmp.getContext('2d');
    if(filter === 'pixelate'){
      const pixelSize = Math.max(4, Math.floor(Math.min(w, h) / 60));
      const sw = Math.max(1, Math.floor(w / pixelSize));
      const sh = Math.max(1, Math.floor(h / pixelSize));
      const small = document.createElement('canvas'); small.width = sw; small.height = sh;
      const sctx = small.getContext('2d');
      sctx.drawImage(canvas, 0, 0, sw, sh);
      tctx.imageSmoothingEnabled = false;
      tctx.clearRect(0,0,w,h);
      tctx.drawImage(small, 0, 0, sw, sh, 0, 0, w, h);
    } else if(filter === 'grayscale' || filter === 'blur'){
      tctx.filter = filter === 'grayscale' ? 'grayscale(100%)' : 'blur(3px)';
      tctx.drawImage(canvas, 0, 0);
    } else {
      return;
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0,0,w,h);
    ctx.drawImage(tmp, 0, 0);
  }

  // Auto-scrape preference
  $('auto-scrape').addEventListener('change', (e)=>{
    const v = !!e.target.checked;
    chrome.storage.local.set({ nearby_only_auto_scrape: v }, ()=> setStatus('Preference saved'));
  });

  // load preferences
  chrome.storage.local.get({ nearby_only_auto_scrape: false }, (res)=>{
    $('auto-scrape').checked = !!res.nearby_only_auto_scrape;
  });

  // facepp credentials save/load
  $('facepp_save').addEventListener('click', ()=>{
    const key = $('facepp_key').value.trim();
    const secret = $('facepp_secret').value.trim();
    const endpoint = $('facepp_endpoint').value.trim();
    if(!key || !secret) return setStatus('Provide key and secret');
    chrome.storage.local.set({ facepp: { key, secret, endpoint } }, ()=> setStatus('Face++ keys saved'));
  });

  $('facepp_run').addEventListener('click', async ()=>{
    setStatus('Starting Face++ detection on stored profiles...');
    await sendToActive({ type: 'facepp_detect_all' });
  });

  // load stored facepp keys (do not display secret for security)
  chrome.storage.local.get({ facepp: {} }, (res)=>{
    const f = res.facepp || {};
    if(f.key) $('facepp_key').value = f.key;
    if(f.endpoint) $('facepp_endpoint').value = f.endpoint;
  });

  // show stored count
  async function refreshCount(){
    chrome.storage.local.get({ nearby_only_profiles: [] }, (res)=>{
      const arr = Array.isArray(res.nearby_only_profiles) ? res.nearby_only_profiles : [];
      setStatus(arr.length + ' profiles stored');
    });
  }
  refreshCount();
  // poll occasionally
  setInterval(refreshCount, 3000);
})();
