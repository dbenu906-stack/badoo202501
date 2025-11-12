// Minimal content script for "nearby-only" extension
// Purpose: When Badoo Nearby tab/page is active, auto-scroll the nearby grid
// and extract name/age (and an image URL) from each profile. Send batches to
// background to persist under `nearby_only_profiles`.

(function(){
  const LOG = (...args) => console.debug('[nearby-only]', ...args);
  const NEARBY_TAB_SELECTOR = '#tabbar > nav > button:nth-child(2)';
  let __nearby_only_should_stop = false;

  function emulateSwipe(container, direction = 'down'){
    try{
      // container may be element or document
      const target = (container && container !== window) ? container : document.scrollingElement || document.documentElement;
      const rect = (target.getBoundingClientRect && target.getBoundingClientRect()) || {left:0, top:0, width: window.innerWidth, height: window.innerHeight};
      const startX = rect.left + (rect.width/2);
      const startY = rect.top + (rect.height * 0.8);
      const endY = rect.top + (rect.height * 0.2);
      const steps = 8;
      // dispatch pointer events if supported
      const supportsPointer = typeof window.PointerEvent === 'function';
      if(supportsPointer){
        const id = Date.now() % 65536;
        const down = new PointerEvent('pointerdown', {bubbles:true,cancelable:true,pointerId:id,clientX:startX,clientY:startY,isPrimary:true});
        target.dispatchEvent(down);
        for(let i=1;i<=steps;i++){
          const t = i/steps;
          const y = startY + (endY - startY) * t;
          const move = new PointerEvent('pointermove', {bubbles:true,cancelable:true,pointerId:id,clientX:startX,clientY:Math.floor(y),isPrimary:true});
          target.dispatchEvent(move);
        }
        const up = new PointerEvent('pointerup', {bubbles:true,cancelable:true,pointerId:id,clientX:startX,clientY:endY,isPrimary:true});
        target.dispatchEvent(up);
      } else {
        // fallback to mouse events
        const mdown = new MouseEvent('mousedown', {bubbles:true,cancelable:true,clientX:startX,clientY:startY});
        target.dispatchEvent(mdown);
        for(let i=1;i<=steps;i++){
          const t = i/steps;
          const y = startY + (endY - startY) * t;
          const move = new MouseEvent('mousemove', {bubbles:true,cancelable:true,clientX:startX,clientY:Math.floor(y)});
          target.dispatchEvent(move);
        }
        const mup = new MouseEvent('mouseup', {bubbles:true,cancelable:true,clientX:startX,clientY:endY});
        target.dispatchEvent(mup);
      }
      // ensure scroll has some effect as fallback
      try{ target.scrollBy && target.scrollBy(0, endY - startY); }catch(e){}
      return true;
    }catch(e){ LOG('emulateSwipe failed', e); return false; }
  }

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
    const cfg = Object.assign({maxSteps:120, stepDelay:650, stopIfNoNew:6, emulatePointer: false}, opts||{});
    const list = findNearbyUL();
    if(!list){ LOG('nearby list not found, aborting'); return []; }
    const container = getScrollableAncestor(list);
    const collected = [];
    const seen = new Set();
    let lastCount = 0, noNew = 0;

    for(let step=0; step<cfg.maxSteps; step++){
      if(__nearby_only_should_stop){ LOG('stop requested, aborting'); break; }
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

      // if we see no new items for a few steps, try pointer emulation swipe and continue
      if(cfg.emulatePointer && noNew >= Math.max(2, Math.floor(cfg.stopIfNoNew/2))){
        LOG('no new items, trying pointer emulation swipe');
        emulateSwipe(container, 'down');
        // allow some time to load
        await new Promise(r => setTimeout(r, Math.max(300, cfg.stepDelay/2)));
        noNew = 0; // reset and continue
        continue;
      }

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
        if(!msg) return;
        if(msg.type === 'start_nearby_only'){
          __nearby_only_should_stop = false;
          autoScrollAndCollect(msg.cfg || {});
          sendResponse({started:true});
          return true;
        }
        if(msg.type === 'stop_nearby_only'){
          __nearby_only_should_stop = true;
          sendResponse({stopped:true});
          return true;
        }
      }catch(e){ LOG('onMessage error', e); }
    });
  }catch(e){}

})();
