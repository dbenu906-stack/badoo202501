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
      for(const p of arr){
        idx++;
        const url = p.image || '';
        const safeName = `profile_${idx}`;
        const ext = (url.split('?')[0].split('.').pop() || 'jpg').slice(0,6);
        const filename = `${safeName}.${ext}`;
        const blob = await fetchAsBlob(url);
        if(blob){ files.push({name: filename, data: blob}); }
        else { files.push({name: `${safeName}_noimage.txt`, data: new Blob([`Failed to fetch: ${url}`], {type:'text/plain'})}); }
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
