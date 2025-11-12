// Minimal content script for "nearby-only" extension
// Purpose: When Badoo Nearby tab/page is active, auto-scroll the nearby grid
// and extract name/age (and an image URL) from each profile. Send batches to
// background to persist under `nearby_only_profiles`.

(function(){
  const LOG = (...args) => console.debug('[nearby-only]', ...args);
  const NEARBY_TAB_SELECTOR = '#tabbar > nav > button:nth-child(2)';

  function findNearbyUL(){
    return document.querySelector('ul.csms-user-list')
      || document.querySelector('ul[class*="csms-user-list"]')
      || document.querySelector('div.people-nearby__content ul')
      || null;
  }

  function getText(el){ try{ return (el && (el.innerText||el.textContent)||'').trim(); }catch(e){return ''; } }

  function extractFromItem(it){
    try{
      const btn = it.querySelector('button[data-qa-user-id]') || it.querySelector('button');
      const id = btn ? (btn.getAttribute('data-qa-user-id')||'') : '';
      const nameEl = it.querySelector('.csms-profile-info__name-inner') || it.querySelector('[data-qa="profile-info__name"]') || null;
      const ageEl = it.querySelector('[data-qa="profile-info__age"]') || it.querySelector('.csms-profile-info__age') || null;
      const imgEl = it.querySelector('.csms-avatar__image') || it.querySelector('img') || null;
      const name = nameEl ? getText(nameEl) : '';
      const age = ageEl ? getText(ageEl).replace(/^,\s*/,'') : '';
      let image = imgEl ? (imgEl.src || imgEl.getAttribute('src') || '') : '';
      if(image && image.startsWith('//')) image = window.location.protocol + image;
      if(!name && !age && !image) return null;
      return { id: id||'', name: name||'', age: age||'', image: image||'' };
    }catch(e){ return null; }
  }

  function extractVisibleProfiles(){
    const list = findNearbyUL();
    const out = [];
    const seen = new Set();
    if(!list) return out;
    const items = Array.from(list.querySelectorAll('li.csms-user-list__item, li'));
    for(const it of items){
      const p = extractFromItem(it);
      if(!p) continue;
      const key = p.id ? ('id:'+p.id) : ((p.name||'')+'||'+(p.age||''));
      if(seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
    return out;
  }

  function getScrollableAncestor(el){
    if(!el) return document.scrollingElement || document.documentElement || window;
    let cur = el;
    while(cur && cur !== document.body && cur !== document.documentElement){
      try{
        const style = window.getComputedStyle(cur);
        if((cur.scrollHeight && cur.clientHeight && cur.scrollHeight > cur.clientHeight) || (style && (style.overflowY==='auto' || style.overflowY==='scroll'))){
          return cur;
        }
      }catch(e){}
      cur = cur.parentElement;
    }
    return document.scrollingElement || document.documentElement || window;
  }

  function sendBatch(profiles){
    if(!profiles || !profiles.length) return;
    try{ chrome.runtime.sendMessage({type:'nearby_only_profiles', profiles}); }catch(e){ LOG('sendBatch error', e); }
  }

  async function autoScrollAndCollect(opts = {}){
    const cfg = Object.assign({maxSteps:120, stepDelay:650, stopIfNoNew:6}, opts||{});
    const list = findNearbyUL();
    if(!list){ LOG('nearby list not found, aborting'); return []; }
    const container = getScrollableAncestor(list);
    const collected = [];
    const seen = new Set();
    let lastCount = 0, noNew = 0;

    for(let step=0; step<cfg.maxSteps; step++){
      const found = extractVisibleProfiles();
      LOG('step', step, 'found', found.length, 'collected', collected.length);
      for(const p of found){
        const key = p.id ? ('id:'+p.id) : ((p.name||'')+'||'+(p.age||''));
        if(seen.has(key)) continue;
        seen.add(key);
        collected.push(p);
      }
      if(found.length) sendBatch(found);
      if(collected.length > lastCount){ lastCount = collected.length; noNew = 0; }
      else noNew++;
      if(noNew >= cfg.stopIfNoNew) break;

      // try to scroll
      try{
        if(container && typeof container.scrollTop === 'number' && container.scrollHeight && container.clientHeight){
          container.scrollTop = Math.min(container.scrollTop + (container.clientHeight || window.innerHeight), Math.max(0, container.scrollHeight - (container.clientHeight || window.innerHeight)));
        } else {
          window.scrollBy(0, Math.max(window.innerHeight * 0.8, 300));
        }
      }catch(e){ try{ window.scrollBy(0, Math.max(window.innerHeight * 0.8, 300)); }catch(_){} }

      await new Promise(r => setTimeout(r, cfg.stepDelay));
    }

    if(collected.length) { LOG('final send', collected.length); sendBatch(collected); }
    LOG('autoScrollAndCollect finished', collected.length);
    return collected;
  }

  // Auto-start when on nearby page or when nearby tab is clicked
  try{
    if(/people[-_]nearby|people-nearby|people\/nearby|nearby/.test(location.pathname+location.href)){
      setTimeout(()=>autoScrollAndCollect(), 800);
    }
  }catch(e){}

  document.addEventListener('click', (ev)=>{
    try{ const btn = ev.target.closest && ev.target.closest(NEARBY_TAB_SELECTOR); if(btn) setTimeout(()=>autoScrollAndCollect(), 700); }catch(e){}
  }, true);

  // respond to messages to start explicitly
  try{
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      try{
        if(msg && msg.type === 'start_nearby_only'){
          autoScrollAndCollect(msg.cfg || {});
          sendResponse({started:true});
          return true;
        }
      }catch(e){ LOG('onMessage error', e); }
    });
  }catch(e){}

})();
