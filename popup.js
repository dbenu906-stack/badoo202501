// Save recommended Badoo selectors as a preset on load if not present
const BADOO_PRESET = {
  // Generalized selectors for the people-nearby list items (class-based, not brittle nth-child chains)
  name: '.csms-profile-info__name',
  age: '.csms-profile-info__age',
  bio: '.profile-card__bio, .csms-user-list-cell__text',
  image: '.csms-user-list-cell__media img, .multimedia-image__image',
  // location/next left as conservative defaults
  location: '',
  next: 'button.profile-action[data-qa="profile-card-action-vote-no"]'
};
const BADOO_PRESET_NAME = 'Badoo Example';
let rows = [];
let autoExtracting = false;
let lastHighlightId = null;

function renderRows() {
  const tbody = document.querySelector('#resultsTable tbody');
  tbody.innerHTML = '';
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    const thumb = r.image ? `<img src="${escapeHtml(r.image)}" style="width:56px;height:56px;object-fit:cover;border-radius:4px"/>` : '';
    tr.innerHTML = `<td>${i+1}</td><td>${thumb}</td><td>${escapeHtml(r.name||'')}</td><td>${escapeHtml(r.age||'')}</td><td>${escapeHtml(r.bio||'')}</td><td>${escapeHtml(r.image||'')}</td>`;
    tbody.appendChild(tr);
  });
}

function escapeHtml(s){
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function getActiveTab() {
  return new Promise(resolve => {
    chrome.tabs.query({active:true,currentWindow:true}, tabs => resolve(tabs[0]));
  });
}

async function extractOnce() {
  const selectors = {
    name: document.getElementById('selName')?.value.trim() || '',
    location: document.getElementById('selLocation')?.value.trim() || '',
    age: document.getElementById('selAge')?.value.trim() || '',
    bio: document.getElementById('selBio')?.value.trim() || '',
    image: document.getElementById('selImage')?.value.trim() || ''
  };

  const tab = await getActiveTab();
  if(!tab) return alert('No active tab');

  // Scroll the main profile card into view before extracting
  await new Promise(resolve => {
    chrome.scripting.executeScript({
      target: {tabId: tab.id},
      func: (sel) => {
        // Try to scroll the main profile card into view
        try {
          // Try common selectors for the main card
          let el = document.querySelector('.profile-card-full') || document.querySelector('.profile-card') || document.body;
          if (el && el.scrollIntoView) el.scrollIntoView({behavior:'smooth',block:'center'});
        } catch(e){}
      },
      args: [selectors]
    }, () => setTimeout(resolve, 400)); // wait a bit for scroll
  });

  chrome.scripting.executeScript({
    target: {tabId: tab.id},
    func: (sel) => {
      const getText = (s) => { try { const el = document.querySelector(s); return el ? el.innerText.trim() : '' } catch(e){ return '' } };
      const getImage = (s) => {
        try {
          const el = document.querySelector(s);
          if(!el) return '';
          if(el.tagName && el.tagName.toLowerCase()==='img'){
            return el.src || el.getAttribute('src') || el.getAttribute('data-src') || el.getAttribute('data-original') || '';
          }
          const attr = el.getAttribute('data-src') || el.getAttribute('data-original') || el.getAttribute('src');
          if(attr) return attr;
          const style = window.getComputedStyle(el);
          if(style && style.backgroundImage && style.backgroundImage!=='none'){
            const m = style.backgroundImage.match(/url\((?:\"|\')?(.*?)(?:\"|\')?\)/);
            if(m) return m[1];
          }
          return '';
        } catch(e){ return '' }
      };
      return {
        name: getText(sel.name),
        location: getText(sel.location),
        age: getText(sel.age),
        bio: getText(sel.bio),
        image: getImage(sel.image)
      };
    },
    args: [selectors]
  }, (results) => {
    if (chrome.runtime.lastError) {
      console.error(chrome.runtime.lastError);
      alert('Error: ' + chrome.runtime.lastError.message);
      return;
    }
    const data = results[0].result || {};
    rows.push(data);
    renderRows();
  });
}

async function exportRowsToZip() {
  if(rows.length===0) return alert('No rows to export');
  setStatus('Preparing images for ZIP...');
  const filter = document.getElementById('imgFilter')?.value || 'none';
  const files = [];
  let index = 0;

  async function fetchAsBlob(url){
    try{
      if(!url) return null;
      if(url.startsWith('data:')){ const res = await fetch(url); return await res.blob(); }
      if(url.startsWith('//')) url = window.location.protocol + url;
      const res = await fetch(url, {mode:'cors'});
      if(!res.ok) return null; return await res.blob();
    }catch(e){ console.warn('fetchAsBlob failed for', url, e); return null; }
  }

  for(const r of rows){
    index++;
    setStatus(`Fetching image ${index}/${rows.length}...`);
    const urlStr = r.image || '';
    const blob = await fetchAsBlob(urlStr);
    const safeName = `img_${index}`;
    const extGuess = (urlStr.split('?')[0].split('.').pop() || 'png').slice(0,6);
    const filename = `${safeName}.${extGuess}`;
    if(blob){
      try{
        setStatus(`Processing image ${index}/${rows.length}...`);
        const processed = await processImageBlob(blob, filter);
        files.push({name: filename, data: processed});
      }catch(e){
        console.warn('processing failed, adding original', e);
        files.push({name: filename, data: blob});
      }
    } else {
      files.push({name: `${safeName}_failed.txt`, data: new Blob([`Failed to fetch image: ${urlStr}`], {type:'text/plain'})});
    }
  }

  setStatus('Generating ZIP file...');
  const zipBlob = await createZipBlob(files);
  const zipUrl = URL.createObjectURL(zipBlob);
  const a = document.createElement('a'); a.href = zipUrl; a.download = 'images.zip'; a.click(); URL.revokeObjectURL(zipUrl);
  setStatus('ZIP download started');

}


// Create a ZIP Blob from an array of {name, data: Blob}
async function createZipBlob(files){
  // CRC32 table
  const crcTable = (()=>{
    const table = new Uint32Array(256);
    for(let i=0;i<256;i++){ let c=i; for(let k=0;k<8;k++) c = ((c&1) ? (0xEDB88320 ^ (c>>>1)) : (c>>>1)); table[i]=c; }
    return table;
  })();
  const crc32 = (buf) => {
    let crc = 0 ^ (-1);
    for(let i=0;i<buf.length;i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
    return (crc ^ (-1)) >>> 0;
  };

  // Convert each file Blob to Uint8Array and compute CRC/size
  const entries = [];
  for(const f of files){
    const ab = await f.data.arrayBuffer();
    const uint8 = new Uint8Array(ab);
    const crc = crc32(uint8);
    entries.push({name:f.name, data:uint8, crc, size:uint8.length});
  }

  const textEncoder = new TextEncoder();
  const parts = [];
  let offset = 0;
  const centralDir = [];

  for(const e of entries){
    const nameBuf = textEncoder.encode(e.name);
    // local file header
    const localHeader = new Uint8Array(30 + nameBuf.length);
    const dv = new DataView(localHeader.buffer);
    let p=0;
    dv.setUint32(p, 0x04034b50, true); p+=4; // signature
    dv.setUint16(p, 20, true); p+=2; // version needed
    dv.setUint16(p, 0, true); p+=2; // flags
    dv.setUint16(p, 0, true); p+=2; // compression method (0 stored)
    dv.setUint16(p, 0, true); p+=2; // mod time
    dv.setUint16(p, 0, true); p+=2; // mod date
    dv.setUint32(p, e.crc, true); p+=4; // crc32
    dv.setUint32(p, e.size, true); p+=4; // compressed size
    dv.setUint32(p, e.size, true); p+=4; // uncompressed size
    dv.setUint16(p, nameBuf.length, true); p+=2; // file name length
    dv.setUint16(p, 0, true); p+=2; // extra len
    localHeader.set(nameBuf, 30);
    parts.push(localHeader);
    parts.push(e.data);

    const centralHeader = new Uint8Array(46 + nameBuf.length);
    const cdv = new DataView(centralHeader.buffer);
    p=0;
    cdv.setUint32(p, 0x02014b50, true); p+=4; // central sig
    cdv.setUint16(p, 0x14, true); p+=2; // version made
    cdv.setUint16(p, 20, true); p+=2; // version needed
    cdv.setUint16(p, 0, true); p+=2; // flags
    cdv.setUint16(p, 0, true); p+=2; // method
    cdv.setUint16(p, 0, true); p+=2; // mod time
    cdv.setUint16(p, 0, true); p+=2; // mod date
    cdv.setUint32(p, e.crc, true); p+=4;
    cdv.setUint32(p, e.size, true); p+=4;
    cdv.setUint32(p, e.size, true); p+=4;
    cdv.setUint16(p, nameBuf.length, true); p+=2;
    cdv.setUint16(p, 0, true); p+=2; // extra
    cdv.setUint16(p, 0, true); p+=2; // comment
    cdv.setUint16(p, 0, true); p+=2; // disk
    cdv.setUint16(p, 0, true); p+=2; // int attr
    cdv.setUint32(p, 0, true); p+=4; // ext attr
    cdv.setUint32(p, offset, true); p+=4; // local header offset
    centralHeader.set(nameBuf, 46);
    centralDir.push(centralHeader);

    offset += localHeader.length + e.size;
  }

  // central directory size
  const centralSize = centralDir.reduce((s, b)=>s + b.length, 0);
  const centralOffset = offset;
  // End of central directory
  const comment = new Uint8Array(0);
  const eocdr = new Uint8Array(22);
  const ev = new DataView(eocdr.buffer);
  let pp=0;
  ev.setUint32(pp, 0x06054b50, true); pp+=4;
  ev.setUint16(pp, 0, true); pp+=2; // disk
  ev.setUint16(pp, 0, true); pp+=2; // disk cd
  ev.setUint16(pp, entries.length, true); pp+=2; // entries this disk
  ev.setUint16(pp, entries.length, true); pp+=2; // total entries
  ev.setUint32(pp, centralSize, true); pp+=4; // size of central
  ev.setUint32(pp, centralOffset, true); pp+=4; // offset of central
  ev.setUint16(pp, 0, true); pp+=2; // comment len

  const blobParts = [];
  // add local headers and file data (we already pushed them into parts in order)
  for(const p of parts) blobParts.push(p instanceof Uint8Array ? p : new Uint8Array(p));
  for(const c of centralDir) blobParts.push(c instanceof Uint8Array ? c : new Uint8Array(c));
  blobParts.push(eocdr);

  return new Blob(blobParts, {type:'application/zip'});
}
// Preset storage (simple)
function loadPresetsToUI(presets){
  const sel = document.getElementById('presetSelect');
  sel.innerHTML = '<option value="">(select)</option>';
  Object.keys(presets||{}).forEach(name => {
    const o = document.createElement('option'); o.value = name; o.textContent = name; sel.appendChild(o);
  });
}

function savePresetUI(){
  const name = document.getElementById('presetName').value.trim();
  if(!name) return alert('Provide a preset name');
  const preset = {
    name: document.getElementById('selName').value,
    age: document.getElementById('selAge').value,
    bio: document.getElementById('selBio').value,
    image: document.getElementById('selImage').value,
    location: document.getElementById('selLocation')?.value || '',
    next: document.getElementById('selNext').value
  };
  chrome.storage.sync.get({presets:{}}, data=>{
    const p = data.presets || {};
    p[name] = preset;
    chrome.storage.sync.set({presets:p}, ()=>{ loadPresetsToUI(p); alert('Preset saved'); });
  });
}

function deletePresetUI(){
  const sel = document.getElementById('presetSelect');
  const key = sel.value; if(!key) return alert('Choose a preset to delete');
  chrome.storage.sync.get({presets:{}}, data=>{
    const p = data.presets||{}; delete p[key]; chrome.storage.sync.set({presets:p}, ()=>{ loadPresetsToUI(p); alert('Deleted'); });
  });
}

function loadPresetIntoFields(name){
  if(!name) return;
  chrome.storage.sync.get({presets:{}}, data=>{
    const p = data.presets||{}; if(p[name]){
      document.getElementById('selName').value = p[name].name||'';
      document.getElementById('selAge').value = p[name].age||'';
      document.getElementById('selBio').value = p[name].bio||'';
      document.getElementById('selImage').value = p[name].image||'';
      if(document.getElementById('selLocation')) document.getElementById('selLocation').value = p[name].location||'';
      document.getElementById('selNext').value = p[name].next||'';
    }
  });
}

function exportCSV(){
  if(rows.length===0) return alert('No rows to export');
  const header = ['Name','Location','Age','Bio','ImageURL'];
  const lines = [header.join(',')];
  for(const r of rows){
    const cells = [r.name||'', r.location||'', r.age||'', r.bio||'', r.image||''].map(c => '"'+(String(c).replace(/"/g,'""'))+'"');
    lines.push(cells.join(','));
  }
  const csv = lines.join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'extracted_profiles.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function setStatus(msg){
  const el = document.getElementById('status');
  if(el) el.textContent = msg;
  const progress = document.getElementById('progressBar');
  if(progress && msg==='' ) { progress.value = 0; progress.max = 100; }
}

// --- Image processing and ZIP export ---
// Apply selected filter (none|grayscale|pixelate|blur) to an image Blob and return a processed Blob (PNG)
async function processImageBlob(blob, filter){
  // If local detection is enabled and consented, detect faces locally and anonymize them before applying global filter
  const cfg = getFacePPConfigFromUI();
  let faceRects = null;
  if(cfg.enable && cfg.consent){
    try{
      const dets = await detectFacesWithFaceApi(blob);
      faceRects = (dets||[]).map(d => ({ left: Math.round(d.x), top: Math.round(d.y), width: Math.round(d.width), height: Math.round(d.height) }));
    }catch(e){ console.warn('Local face detection failed', e); setStatus('Local face detection failed'); }
  }

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

        // apply face anonymization if we have rectangles
        if(faceRects && faceRects.length>0){
          await applyFaceAnonymization(canvas, faceRects, document.getElementById('faceppMethod')?.value || 'pixelate');
        }

        // apply global filter after face-level anonymization
        await applyGlobalFilter(canvas, filter);

        // export as PNG blob
        canvas.toBlob((b)=>{ if(b) resolve(b); else reject(new Error('toBlob failed')); }, 'image/png');
      }catch(err){ reject(err); }
    };
    img.onerror = (e)=> reject(new Error('Image load error'));
    // create object URL from blob
    const url = URL.createObjectURL(blob);
    img.crossOrigin = 'anonymous';
    img.src = url;
    // revoke url after load
    img.addEventListener('load', ()=> URL.revokeObjectURL(url));
  });
}

// Helper: downscale large blobs to a reasonable size for upload to Face++
async function downscaleBlobIfNeeded(blob, maxBytes=2500000, maxDim=1280){
  try{
    if(blob.size <= maxBytes) return blob;
    const img = await new Promise((res, rej)=>{
      const i = new Image();
      const url = URL.createObjectURL(blob);
      i.onload = ()=>{ URL.revokeObjectURL(url); res(i); };
      i.onerror = (e)=>{ URL.revokeObjectURL(url); rej(e); };
      i.src = url; i.crossOrigin = 'anonymous';
    });
    const ratio = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * ratio);
    const h = Math.round(img.naturalHeight * ratio);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const cx = c.getContext('2d'); cx.drawImage(img,0,0,w,h);
    return await new Promise(res=>c.toBlob(b=>res(b), 'image/jpeg', 0.85));
  }catch(e){ console.warn('downscale failed', e); return blob; }
}

function getFacePPConfigFromUI(){
  return {
    enable: !!document.getElementById('faceppEnable')?.checked,
    consent: !!document.getElementById('faceppConsent')?.checked,
    method: document.getElementById('faceppMethod')?.value || 'pixelate'
  };
}

// Local face-api.js helpers
let faceApiLoaded = false;
async function ensureFaceApiModels(modelPath='models'){
  if(faceApiLoaded) return;
  if(typeof faceapi === 'undefined') throw new Error('face-api.js not loaded');
  // modelPath is relative inside the extension; convert to a chrome-extension:// URL so loadFromUri works in the extension context
  try{
    const modelBaseLocal = chrome && chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL(modelPath) : modelPath;
    // First try loading models from the extension's local models folder
    try{
      await faceapi.nets.tinyFaceDetector.loadFromUri(modelBaseLocal);
      faceApiLoaded = true;
      return;
    }catch(localErr){
      console.warn('Local model load failed, will try remote fallback:', localErr && localErr.message);
    }
    // Fallback: try loading from the public hosted models (official demo host)
    const fallback = 'https://justadudewhohacks.github.io/face-api.js/models';
    await faceapi.nets.tinyFaceDetector.loadFromUri(fallback);
    faceApiLoaded = true;
  }catch(err){
    // rethrow with clearer message
    throw new Error('Failed to load face models (local and remote): '+(err && err.message ? err.message : String(err)));
  }
}

// Download models from the public host and store them in chrome.storage.local for offline loading
async function downloadAndStoreFaceApiModels(){
  const base = 'https://justadudewhohacks.github.io/face-api.js/models';
  // fetch manifest
  const manifestUrl = base + '/tiny_face_detector_model-weights_manifest.json';
  const mf = await fetch(manifestUrl);
  if(!mf.ok) throw new Error('Failed to fetch manifest');
  const manifest = await mf.json();
  // manifest is an array; first entry has paths array
  const paths = manifest[0] && manifest[0].paths ? manifest[0].paths : [];
  const store = {manifest: manifest, files:{}};
  for(const p of paths){
    const url = base + '/' + p + '.bin';
    const r = await fetch(url);
    if(!r.ok) throw new Error('Failed to fetch '+url);
    const ab = await r.arrayBuffer();
    // store as base64 string to chrome.storage.local
    const b64 = arrayBufferToBase64(ab);
    store.files[p] = b64;
  }
  // persist
  await new Promise(res=>chrome.storage.local.set({faceapi_models: store}, ()=>res()));
}

function arrayBufferToBase64(buffer){
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for(let i=0;i<len;i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToArrayBuffer(b64){
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for(let i=0;i<len;i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}


async function detectFacesWithFaceApi(blob){
  // attempt to use stored models in chrome.storage.local by intercepting fetch
  const stored = await new Promise(res=>chrome.storage.local.get({faceapi_models:null}, r=>res(r.faceapi_models)));
  let restoreFetch = null;
  if(stored && stored.manifest){
    // intercept fetch to serve stored model files
    const origFetch = window.fetch;
    restoreFetch = ()=>{ window.fetch = origFetch; };
    window.fetch = async function(input, init){
      try{
        const url = (typeof input === 'string') ? input : input.url;
        // respond with manifest if requested
        if(url.endsWith('tiny_face_detector_model-weights_manifest.json') && stored.manifest){
          return new Response(JSON.stringify(stored.manifest), {status:200, headers:{'Content-Type':'application/json'}});
        }
        // check if request targets a known model filename
        for(const fname of Object.keys(stored.files)){
          if(url.endsWith('/'+fname) || url.endsWith('/'+fname+'.bin') || url.endsWith(fname) ){
            const b64 = stored.files[fname];
            const ab = base64ToArrayBuffer(b64);
            return new Response(ab, {status:200, headers:{'Content-Type':'application/octet-stream'}});
          }
        }
      }catch(e){ console.warn('fetch interceptor error', e); }
      return origFetch(input, init);
    };
  }
  await ensureFaceApiModels();
  if(restoreFetch) restoreFetch();
  const img = await new Promise((res, rej)=>{
    const i = new Image();
    const url = URL.createObjectURL(blob);
    i.onload = ()=>{ URL.revokeObjectURL(url); res(i); };
    i.onerror = (e)=>{ URL.revokeObjectURL(url); rej(e); };
    i.src = url; i.crossOrigin = 'anonymous';
  });
  const detections = await faceapi.detectAllFaces(img, new faceapi.TinyFaceDetectorOptions({inputSize: 512, scoreThreshold: 0.5}));
  // map to simpler rect objects
  return detections.map(d=>({ x: d.box.x, y: d.box.y, width: d.box.width, height: d.box.height }));
}

// Apply anonymization to face rectangles on the given canvas
async function applyFaceAnonymization(canvas, rects, method){
  const ctx = canvas.getContext('2d');
  for(const r of rects){
    const sx = r.left || r.x || 0;
    const sy = r.top || r.y || 0;
    const sw = r.width || r.w || 0;
    const sh = r.height || r.h || 0;
    if(sw <=0 || sh<=0) continue;
    if(method === 'pixelate'){
      const tmp = document.createElement('canvas');
      const scale = Math.max(2, Math.floor(Math.min(sw, sh) / 10));
      tmp.width = Math.max(1, Math.floor(sw / scale));
      tmp.height = Math.max(1, Math.floor(sh / scale));
      const tctx = tmp.getContext('2d');
      // draw the face region small
      tctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, tmp.width, tmp.height);
      // draw back scaled up without smoothing
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(sx, sy, sw, sh);
      ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, sx, sy, sw, sh);
      ctx.imageSmoothingEnabled = true;
    } else if(method === 'blur'){
      const tmp = document.createElement('canvas'); tmp.width = sw; tmp.height = sh;
      const tctx = tmp.getContext('2d');
      tctx.filter = 'blur(8px)';
      tctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
      // copy back
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
    return; // unknown, no-op
  }
  // copy back
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,w,h);
  ctx.drawImage(tmp, 0, 0);
}

async function previewFirstImage(){
  if(rows.length===0) return alert('No rows to preview');
  const first = rows[0];
  const url = first.image;
  if(!url) return alert('No image URL in first row');
  try{
    const blob = await (async function fetchAsBlob(u){
      if(!u) return null;
      if(u.startsWith('data:')){ const res = await fetch(u); return await res.blob(); }
      if(u.startsWith('//')) u = window.location.protocol + u;
      const res = await fetch(u, {mode:'cors'});
      if(!res.ok) return null; return await res.blob();
    })(url);
    if(!blob) return alert('Failed to fetch image for preview (CORS?)');
    const filter = document.getElementById('imgFilter')?.value || 'none';
    const processed = await processImageBlob(blob, filter);
    const dataUrl = URL.createObjectURL(processed);
    window.open(dataUrl, '_blank');
    setStatus('Preview opened in new tab');
  }catch(e){ console.error(e); alert('Preview failed: '+e.message); }
}

// Export CSV with embedded base64 images (may produce large CSV files)
async function exportCSVWithImages(){
  if(rows.length===0) return alert('No rows to export');
  setStatus('Preparing CSV with images...');
  const progress = document.getElementById('progressBar');
  progress.value = 0; progress.max = rows.length;

  async function fetchAsDataURL(url){
    try{
      if(!url) return '';
      if(url.startsWith('data:')) return url;
      if(url.startsWith('//')) url = window.location.protocol + url;
      const res = await fetch(url, {mode:'cors'});
      if(!res.ok) return '';
      const blob = await res.blob();
      return await new Promise((resolve)=>{
        const reader = new FileReader();
        reader.onload = ()=>resolve(reader.result);
        reader.onerror = ()=>resolve('');
        reader.readAsDataURL(blob);
      });
    }catch(e){ console.warn('fetch as data url failed', e); return ''; }
  }

  const header = ['Name','Location','Age','Bio','ImageURL','ImageDataURI'];
  const lines = [header.join(',')];
  let idx = 0;
  for(const r of rows){
    idx++;
    setStatus(`Fetching image ${idx}/${rows.length}...`);
    progress.value = idx;
    const dataUrl = await fetchAsDataURL(r.image || '');
    const cells = [r.name||'', r.location||'', r.age||'', r.bio||'', r.image||'', dataUrl||''].map(c => '"'+(String(c).replace(/"/g,'""'))+'"');
    lines.push(cells.join(','));
  }

  const csv = lines.join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'extracted_profiles_with_images.csv'; a.click(); URL.revokeObjectURL(url);
  setStatus('CSV with images downloaded'); progress.value = 0;
}

async function exportImagesZip(){
  if(rows.length===0) return alert('No rows to export');
  if(typeof window.JSZip === 'undefined'){
    return alert('JSZip is not available. Please add jszip.min.js to the extension and reference it from popup.html. See README for instructions.');
  }
  const zip = new window.JSZip();
  const folder = zip.folder('images');
  let index = 0;
  const filter = document.getElementById('imgFilter')?.value || 'none';

  async function fetchAsBlob(url){
    try{
      if(!url) return null;
      if(url.startsWith('data:')){ const res = await fetch(url); return await res.blob(); }
      if(url.startsWith('//')) url = window.location.protocol + url;
      const res = await fetch(url, {mode:'cors'});
      if(!res.ok) return null; return await res.blob();
    }catch(e){ console.warn('fetchAsBlob failed for', url, e); return null; }
  }

  for(const r of rows){
    index++;
    const url = r.image || '';
    const safeName = `img_${index}`;
    const extGuess = (url.split('?')[0].split('.').pop() || 'png').slice(0,6);
    const filename = `${safeName}.${extGuess}`;
    const blob = await fetchAsBlob(url);
    if(blob){
      try{
        setStatus(`Processing image ${index} / ${rows.length} ...`);
        const processed = await processImageBlob(blob, filter);
        folder.file(filename, processed);
      }catch(e){
        console.warn('processing failed, adding original', e);
        folder.file(filename, blob);
      }
    } else {
      folder.file(`${safeName}_failed.txt`, `Failed to fetch image: ${url}`);
    }
  }
  setStatus('Generating ZIP file...');
  const content = await zip.generateAsync({type:'blob'});
  const url = URL.createObjectURL(content);
  const a = document.createElement('a');
  a.href = url; a.download = 'images.zip'; a.click(); URL.revokeObjectURL(url);
  setStatus('ZIP download started');
}
// --- Auto Extract logic ---
// Perform an in-page "next" action: click configured selector, click common next buttons, or scroll/swipe the profile container.
async function performNextOnPage(){
  const sel = document.getElementById('selNext')?.value.trim() || '';
  const useTouch = !!document.getElementById('useTouchSwipe')?.checked;
  // read swipe tweak values from UI (numbers)
  const swipeDistance = parseInt(document.getElementById('swipeDistance')?.value || '70', 10) || 70;
  const swipeSteps = parseInt(document.getElementById('swipeSteps')?.value || '6', 10) || 6;
  const swipeDuration = parseInt(document.getElementById('swipeDuration')?.value || '300', 10) || 300;
  const swipeCfg = { distancePercent: swipeDistance, steps: swipeSteps, duration: swipeDuration };
  const tab = await getActiveTab();
  if(!tab) return;
  return new Promise(resolve => {
    chrome.scripting.executeScript({
      target: {tabId: tab.id},
      func: async (nextSelector, useTouchSwipe, swipeCfg) => {
        try{
          // 1) If user provided a selector, try click it
          if(nextSelector){
            try{
              const el = document.querySelector(nextSelector);
              if(el){ el.click(); return true; }
            }catch(e){}
          }

          // 2) Try common next/vote buttons
          const candidates = [];
          // common attributes used by various swipe apps
          ['button.next','button[aria-label*="Next"]','button[aria-label*="No"]','button[data-action*="no"]','button[data-qa*="vote-no"]','.pass-button','.profile-action'].forEach(s=>{
            document.querySelectorAll(s).forEach(el=>candidates.push(el));
          });
          if(candidates.length){ try{ candidates[0].click(); return true; }catch(e){} }

          // 3) Try to find the main profile card and either swipe it (touch) or scroll the next sibling into view
          const card = document.querySelector('.profile-card-full') || document.querySelector('.profile-card') || document.querySelector('[data-testid="card"]') || document.querySelector('article, main, .card');
          if(card){
            if(useTouchSwipe){
              try{
                const rect = card.getBoundingClientRect();
                // compute symmetric start/end positions based on requested distancePercent
                const dp = Math.max(10, Math.min(100, (swipeCfg && swipeCfg.distancePercent) || 70));
                const halfOffset = (dp/100)/2; // portion to go left/right from center
                const startX = rect.left + rect.width * (0.5 + halfOffset);
                const startY = rect.top + rect.height/2;
                const endX = rect.left + rect.width * (0.5 - halfOffset);
                const dispatch = (type, x, y) => {
                  const ev = new PointerEvent(type, {bubbles:true,cancelable:true,pointerType:'touch',clientX:x,clientY:y});
                  card.dispatchEvent(ev);
                };
                dispatch('pointerdown', startX, startY);
                // step moves with delay to control swipe speed
                const steps = Math.max(1, (swipeCfg && swipeCfg.steps) || 6);
                const duration = Math.max(1, (swipeCfg && swipeCfg.duration) || 300);
                const stepDelay = Math.max(0, Math.floor(duration / steps));
                const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));
                // await the step loop so the function returns after the swipe finishes
                await (async ()=>{
                  for(let i=1;i<=steps;i++){
                    const ix = startX + (endX-startX)*(i/steps);
                    dispatch('pointermove', ix, startY);
                    await sleep(stepDelay);
                  }
                  dispatch('pointerup', endX, startY);
                })();
                return true;
              }catch(e){ console.warn('touch swipe failed', e); }
            }
            // If not using touch or swipe failed, attempt to scroll next into view
            const next = card.nextElementSibling;
            if(next){ next.scrollIntoView({behavior:'smooth', block:'center'}); return true; }
            try{ window.scrollBy({top: card.clientHeight || (window.innerHeight*0.8), left:0, behavior:'smooth'}); return true; }catch(e){}
          }

          // 4) As a last resort, dispatch a keyboard event (ArrowRight) which some apps listen to
          try{
            const ev = new KeyboardEvent('keydown', {key:'ArrowRight', code:'ArrowRight', keyCode:39, which:39, bubbles:true});
            document.dispatchEvent(ev);
            return true;
          }catch(e){}
        }catch(err){ /* ignore */ }
        return false;
      },
      args: [sel, useTouch]
    }, (results)=>{ resolve(results && results[0] && results[0].result); });
  });
}

async function startAutoExtract(){
  if(autoExtracting) return;
  autoExtracting = true;
  let count = 0;
  const maxProfiles = 50; // safety limit
  let lastName = '';
  // Get delay from UI
  let delayInput = document.getElementById('autoDelay');
  let autoDelay = 900;
  if(delayInput && delayInput.value) {
    autoDelay = Math.max(100, Math.min(10000, parseInt(delayInput.value, 10) || 900));
  }
  // Helper to get the current name from the page
  async function getCurrentNameSelector() {
    const sel = document.getElementById('selName')?.value.trim() || '';
    const tab = await getActiveTab();
    return new Promise(resolve => {
      chrome.scripting.executeScript({
        target: {tabId: tab.id},
        func: (selector) => {
          try {
            const el = document.querySelector(selector);
            return el ? el.innerText.trim() : '';
          } catch(e) { return ''; }
        },
        args: [sel]
      }, (results) => {
        if (chrome.runtime.lastError) return resolve('');
        resolve(results[0]?.result || '');
      });
    });
  }
  async function loop(){
    if(!autoExtracting || count >= maxProfiles) { autoExtracting = false; return; }

    // Extract current profile first
    try{
      await extractOnce();
    }catch(e){ console.warn('extractOnce failed', e); }
    count++;

    // After extraction, navigate to next profile (swipe/click/scroll)
    if(!autoExtracting || count >= maxProfiles) { autoExtracting = false; return; }
    const moved = await performNextOnPage();

    // Wait for the page to present a new profile (name change). Try up to ~6s.
    let tries = 0;
    let newName = lastName;
    let changed = false;
    while(tries < 30) {
      await new Promise(r=>setTimeout(r, 200));
      try{ newName = await getCurrentNameSelector(); }catch(e){ newName = ''; }
      if(newName && newName !== lastName) { changed = true; break; }
      tries++;
    }
    if(!changed){
      // fallback: short delay to allow UI to update
      await new Promise(r=>setTimeout(r, 600));
    }
    lastName = newName;

    // Wait user-configured delay before next extraction
    setTimeout(loop, autoDelay);
  }
  loop();
}
function stopAutoExtract(){ autoExtracting = false; }

function clearRows(){ rows = []; renderRows(); }

document.addEventListener('DOMContentLoaded', ()=>{
  // On load, ensure Badoo Example preset exists
  chrome.storage.sync.get({presets:{}}, data=>{
    const p = data.presets||{};
    if(!p[BADOO_PRESET_NAME]){
      p[BADOO_PRESET_NAME] = BADOO_PRESET;
      chrome.storage.sync.set({presets:p}, ()=>{ loadPresetsToUI(p); });
    }
  });
  document.getElementById('btnExtract').addEventListener('click', extractOnce);
  document.getElementById('btnNext').addEventListener('click', performNextOnPage);
  document.getElementById('btnExport').addEventListener('click', exportCSV);
    document.getElementById('btnExportZip')?.addEventListener('click', exportImagesZip);
  document.getElementById('btnClear').addEventListener('click', clearRows);
  document.getElementById('btnExportWithImages')?.addEventListener('click', exportCSVWithImages);
  document.getElementById('btnAuto')?.addEventListener('click', startAutoExtract);
  // Load profiles scraped by content script (nearby pages)
  const loadNearbyBtn = document.getElementById('btnLoadNearby');
  if(loadNearbyBtn){
    loadNearbyBtn.addEventListener('click', ()=>{
      chrome.storage.local.get({nearby_profiles:[]}, data=>{
        const arr = Array.isArray(data.nearby_profiles) ? data.nearby_profiles : [];
        if(arr.length===0) return alert('No nearby profiles saved yet');
        // merge into rows and render (preserve id and age if present)
        for(const p of arr){ rows.push({id: p.id||'', name: p.name||'', age: p.age||'', bio:'', image: p.image||''}); }
        renderRows();
        setStatus(`Loaded ${arr.length} nearby profiles`);
      });
    });
  }
  // Start nearby scrape on the active tab (sends message to content script)
  const startNearbyBtn = document.getElementById('btnStartNearby');
  if(startNearbyBtn){
    startNearbyBtn.addEventListener('click', async ()=>{
      const tab = await getActiveTab(); if(!tab) return alert('No active tab');
      chrome.tabs.sendMessage(tab.id, {type: 'start_nearby_scrape', cfg: {maxSteps:80, stepDelay:700, stopIfNoNew:6}}, (resp)=>{
        if(chrome.runtime.lastError){
          // likely no content script injected on this page
          alert('Failed to send message to page: ' + (chrome.runtime.lastError && chrome.runtime.lastError.message));
          return;
        }
        setStatus('Nearby scrape started on page');
      });
    });
  }
  document.getElementById('btnStopAuto')?.addEventListener('click', stopAutoExtract);
  document.getElementById('btnPreview')?.addEventListener('click', previewFirstImage);
  // highlight buttons
  document.getElementById('hlName').addEventListener('click', ()=>highlightSelector(document.getElementById('selName').value.trim()));
  document.getElementById('hlLocation')?.addEventListener('click', ()=>highlightSelector(document.getElementById('selLocation').value.trim()));
  document.getElementById('hlAge').addEventListener('click', ()=>highlightSelector(document.getElementById('selAge').value.trim()));
  document.getElementById('hlBio').addEventListener('click', ()=>highlightSelector(document.getElementById('selBio').value.trim()));
  document.getElementById('hlImage').addEventListener('click', ()=>highlightSelector(document.getElementById('selImage').value.trim()));
  document.getElementById('hlNext').addEventListener('click', ()=>highlightSelector(document.getElementById('selNext').value.trim()));
  // preset buttons
  document.getElementById('savePreset').addEventListener('click', savePresetUI);
  document.getElementById('deletePreset').addEventListener('click', deletePresetUI);
  document.getElementById('presetSelect').addEventListener('change', (e)=>{ loadPresetIntoFields(e.target.value); });

  // load presets into UI
  chrome.storage.sync.get({presets:{}}, data=>{ loadPresetsToUI(data.presets||{}); });

  renderRows();

  // Wire face detection enable to preload local models when requested
  const enableBox = document.getElementById('faceppEnable');
  if(enableBox){
    enableBox.addEventListener('change', async (e)=>{
      if(e.target.checked){
        setStatus('Loading face detection models...');
        try{ await ensureFaceApiModels(); setStatus('Face detection models loaded'); }
        catch(err){ console.error('Model load failed', err); setStatus('Failed to load face models'); }
      } else {
        setStatus('');
      }
    });
  }

  // Download models button
  const dlBtn = document.getElementById('btnDownloadModels');
  if(dlBtn){
    dlBtn.addEventListener('click', async ()=>{
      setStatus('Downloading models...');
      try{
        await downloadAndStoreFaceApiModels();
        setStatus('Models downloaded to local storage');
        const ms = document.getElementById('modelsStatus'); if(ms){ ms.textContent = 'Loaded'; ms.style.color='green'; }
      }catch(err){ console.error('Download failed', err); setStatus('Model download failed: '+err.message); }
    });
  }

  // Touch swipe checkbox (no UI wiring beyond reading the checkbox in performNextOnPage)
  // Swipe tweak controls: load/save persisted values and wire changes
  const swipeDistanceEl = document.getElementById('swipeDistance');
  const swipeStepsEl = document.getElementById('swipeSteps');
  const swipeDurationEl = document.getElementById('swipeDuration');
  chrome.storage.sync.get({swipeDistance:70, swipeSteps:6, swipeDuration:300}, data=>{
    if(swipeDistanceEl) swipeDistanceEl.value = data.swipeDistance || 70;
    if(swipeStepsEl) swipeStepsEl.value = data.swipeSteps || 6;
    if(swipeDurationEl) swipeDurationEl.value = data.swipeDuration || 300;
  });
  const persistSwipe = ()=>{
    const d = parseInt(swipeDistanceEl?.value||'70',10)||70;
    const s = parseInt(swipeStepsEl?.value||'6',10)||6;
    const dd = parseInt(swipeDurationEl?.value||'300',10)||300;
    chrome.storage.sync.set({swipeDistance:d, swipeSteps:s, swipeDuration:dd});
  };
  if(swipeDistanceEl) swipeDistanceEl.addEventListener('change', persistSwipe);
  if(swipeStepsEl) swipeStepsEl.addEventListener('change', persistSwipe);
  if(swipeDurationEl) swipeDurationEl.addEventListener('change', persistSwipe);
  // update the visible modelsStatus element when models are loaded
  const modelsStatus = document.getElementById('modelsStatus');
  if(modelsStatus){
    // poll until faceApiLoaded becomes true or an error is shown
    const upd = ()=>{
      if(faceApiLoaded){ modelsStatus.textContent = 'Loaded'; modelsStatus.style.color = 'green'; }
      else if(document.getElementById('status') && document.getElementById('status').textContent.includes('Failed to load')){ modelsStatus.textContent = 'Failed'; modelsStatus.style.color = 'crimson'; }
      else { modelsStatus.textContent = 'Not loaded'; modelsStatus.style.color = 'crimson'; }
    };
    upd();
    const iv = setInterval(()=>{
      upd();
      if(faceApiLoaded || (document.getElementById('status') && document.getElementById('status').textContent.includes('Failed to load'))) clearInterval(iv);
    }, 500);
  }
});
