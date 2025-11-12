(function(){
  const $ = id => document.getElementById(id);
  const status = $('status');
  function setStatus(s){ status.textContent = s; }

  async function sendToActive(msg){
    try{
      const [tab] = await chrome.tabs.query({active:true,lastFocusedWindow:true});
      if(!tab) return setStatus('No active tab');
      chrome.tabs.sendMessage(tab.id, msg, (resp)=>{
        if(chrome.runtime.lastError) setStatus(chrome.runtime.lastError.message);
        else setStatus('Sent: ' + (msg.type||''));
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
    chrome.storage.local.get({ nearby_only_profiles: [] }, (res)=>{
      const arr = Array.isArray(res.nearby_only_profiles) ? res.nearby_only_profiles : [];
      if(!arr.length) return setStatus('No profiles to export');
      const csv = toCSV(arr);
      // create a blob url and open in new tab for download
      const blob = new Blob([csv], {type:'text/csv'});
      const url = URL.createObjectURL(blob);
      const win = window.open(url, '_blank');
      setStatus('Exported ' + arr.length + ' profiles');
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

  // Auto-scrape preference
  $('auto-scrape').addEventListener('change', (e)=>{
    const v = !!e.target.checked;
    chrome.storage.local.set({ nearby_only_auto_scrape: v }, ()=> setStatus('Preference saved'));
  });

  // load preferences
  chrome.storage.local.get({ nearby_only_auto_scrape: false }, (res)=>{
    $('auto-scrape').checked = !!res.nearby_only_auto_scrape;
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
