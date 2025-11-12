// Content script: detect when the Nearby tab (or people-nearby page) is opened
// and scrape visible profile cards (name and image heuristics). Sends data to
// the extension background to store under `nearby_profiles`.

(function(){
  const NEARBY_TAB_SELECTOR = '#tabbar > nav > button:nth-child(2)';

  function getImageFromElement(el){
    try{
      if(!el) return '';
      // prefer img tags
      const img = el.querySelector('img');
      if(img){ return img.src || img.getAttribute('src') || img.getAttribute('data-src') || ''; }
      // check attributes on element
      const attr = el.getAttribute && (el.getAttribute('data-src') || el.getAttribute('data-original') || el.getAttribute('src'));
      if(attr) return attr;
      // background-image
      const style = window.getComputedStyle(el);
      if(style && style.backgroundImage && style.backgroundImage !== 'none'){
        const m = style.backgroundImage.match(/url\((?:"|')?(.*?)(?:"|')?\)/);
        if(m) return m[1];
      }
    }catch(e){ console.warn('getImageFromElement error', e); }
    return '';
  }

  function getNameFromElement(el){
    try{
      // try common subselectors used on Badoo-ish cards
      const nameEl = el.querySelector('[data-qa*="name"]') || el.querySelector('.name') || el.querySelector('h3') || el.querySelector('h2') || el.querySelector('.profile-card-info__name');
      if(nameEl) return nameEl.innerText.trim();
      // fallback: first text node inside the card
      const txt = el.innerText || '';
      const lines = txt.split(/\n/).map(s=>s.trim()).filter(Boolean);
      return lines.length ? lines[0] : '';
    }catch(e){ console.warn('getNameFromElement error', e); }
    return '';
  }

  function findNearbyList(){
    // Try a few reliable Badoo selectors (user-provided markup uses csms-user-list)
    return document.querySelector('ul.csms-user-list')
      || document.querySelector('ul[class*="csms-user-list"]')
      || document.querySelector('div.people-nearby__content ul')
      || document.querySelector('div.people-nearby__content')
      || null;
  }

  function getScrollableAncestor(el){
    if(!el) return document.scrollingElement || document.documentElement || window;
    let cur = el;
    while(cur && cur !== document.body && cur !== document.documentElement){
      try{
        const style = window.getComputedStyle(cur);
        const overflowY = style && style.overflowY;
        if((cur.scrollHeight && cur.clientHeight && cur.scrollHeight > cur.clientHeight) || (overflowY && (overflowY === 'auto' || overflowY === 'scroll'))){
          return cur;
        }
      }catch(e){}
      cur = cur.parentElement;
    }
    // fallback to the document scrolling element
    return document.scrollingElement || document.documentElement || window;
  }

  function extractProfilesFromDOM(){
    const out = [];
    const seen = new Set();

    try{
      const list = findNearbyList();
      if(list){
        // collect all list items (li elements) or direct child buttons with data-qa-user-id
        const items = list.querySelectorAll('li.csms-user-list__item, li, > li');
        console.debug('[content-script] nearby UL found, items:', items ? items.length : 0);
        let idx = 0;
        for(const it of items){
          idx++;
          try{
            const btn = it.querySelector('button[data-qa-user-id]') || it.querySelector('button');
            const userId = btn ? (btn.getAttribute('data-qa-user-id') || '') : '';
            const nameInner = it.querySelector('.csms-profile-info__name-inner') || it.querySelector('[data-qa="profile-info__name"]');
            const ageEl = it.querySelector('[data-qa="profile-info__age"]') || it.querySelector('.csms-profile-info__age');
            const imgEl = it.querySelector('.csms-avatar__image') || it.querySelector('.csms-user-list-cell__media img') || it.querySelector('img');
            const name = nameInner ? (nameInner.innerText || nameInner.textContent || '').trim() : getNameFromElement(it);
            let image = imgEl ? (imgEl.src || imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '') : getImageFromElement(it);
            const age = ageEl ? (ageEl.innerText || ageEl.textContent || '').trim().replace(/^,\s*/,'') : '';
            if(image && image.startsWith('//')) image = window.location.protocol + image;
            const key = userId ? ('id:'+userId) : ((image||'') + '||' + (name||''));
            if(!name && !image) continue;
            if(seen.has(key)) continue;
            seen.add(key);
            out.push({id: userId||'', name: name||'', age: age||'', image: image||''});
            if(idx <= 10) console.debug('[content-script] found item', {idx, key, id: userId, name, age, image});
          }catch(e){ /* ignore item errors */ }
        }
        out.sort((a,b)=>{ const wa = (a.image?1:0)+(a.name?1:0); const wb = (b.image?1:0)+(b.name?1:0); return wb-wa; });
        return out.slice(0, 2000);
      }
    }catch(e){ console.warn('nearby UL extraction failed', e); }

    // fallback: gather any buttons with data-qa-user-id across the page (covers alternative layouts)
    try{
      const btns = Array.from(document.querySelectorAll('button[data-qa-user-id]'));
      if(btns && btns.length){
        console.debug('[content-script] fallback button scan found', btns.length);
        for(const btn of btns){
          try{
            const userId = btn.getAttribute('data-qa-user-id') || '';
            const wrapper = btn.closest('.csms-user-list__item') || btn.closest('li') || btn;
            const nameInner = wrapper ? (wrapper.querySelector('.csms-profile-info__name-inner') || wrapper.querySelector('[data-qa="profile-info__name"]')) : null;
            const ageEl = wrapper ? (wrapper.querySelector('[data-qa="profile-info__age"]') || wrapper.querySelector('.csms-profile-info__age')) : null;
            const imgEl = wrapper ? (wrapper.querySelector('.csms-avatar__image') || wrapper.querySelector('img')) : (btn.querySelector('img') || null);
            const name = nameInner ? (nameInner.innerText || nameInner.textContent || '').trim() : getNameFromElement(wrapper || btn);
            let image = imgEl ? (imgEl.src || imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '') : getImageFromElement(wrapper || btn);
            const age = ageEl ? (ageEl.innerText || ageEl.textContent || '').trim().replace(/^,\s*/,'') : '';
            if(image && image.startsWith('//')) image = window.location.protocol + image;
            const key = userId ? ('id:'+userId) : ((image||'') + '||' + (name||''));
            if(!name && !image) continue;
            if(seen.has(key)) continue;
            seen.add(key);
            out.push({id: userId||'', name: name||'', age: age||'', image: image||''});
          }catch(e){ }
        }
        out.sort((a,b)=>{ const wa = (a.image?1:0)+(a.name?1:0); const wb = (b.image?1:0)+(b.name?1:0); return wb-wa; });
        return out.slice(0, 2000);
      }
    }catch(e){ /* ignore */ }

    // last-resort: generic scan (keeps previous heuristics)
    const candidates = Array.from(document.querySelectorAll('article, a, div, li'));
    for(const c of candidates){
      const rect = c.getBoundingClientRect && c.getBoundingClientRect();
      if(rect && rect.width < 40 && rect.height < 40) continue;
      const img = getImageFromElement(c);
      const name = getNameFromElement(c);
      if(!img && !name) continue;
      const key = (img||'') + '||' + (name||'');
      if(seen.has(key)) continue;
      seen.add(key);
      out.push({name: name || '', image: img || ''});
    }
    out.sort((a,b)=>{ const wa = (a.image?1:0)+(a.name?1:0); const wb = (b.image?1:0)+(b.name?1:0); return wb-wa; });
    return out.slice(0, 2000);
  }

  function sendProfiles(profiles){
    try{
      if(!profiles || !profiles.length) return;
      chrome.runtime.sendMessage({type:'nearby_profiles', profiles});
    }catch(e){ console.warn('sendProfiles error', e); }
  }

  function runScrapeOnce(){
    try{
      const profiles = extractProfilesFromDOM();
      sendProfiles(profiles);
    }catch(e){ console.warn('runScrapeOnce failed', e); }
  }

  // Scroll the nearby list (or window) in steps and scrape incrementally.
  async function scrollAndScrapeNearby({maxSteps=100, stepDelay=700, stopIfNoNew=6} = {}){
    try{
  console.debug('[content-script] start scrollAndScrapeNearby', {maxSteps, stepDelay, stopIfNoNew});
  const nearbyList = findNearbyList();
  const container = getScrollableAncestor(nearbyList);
      let lastCount = 0;
      let noNew = 0;
      const collected = [];

      const getVisibleProfiles = () => extractProfilesFromDOM();

      for(let step=0; step<maxSteps; step++){
        // scrape current viewport
        const found = getVisibleProfiles() || [];
        console.debug('[content-script] scroll step', {step, foundCount: found.length, collectedCount: collected.length});
        // dedupe against collected
        for(const p of found){
          const key = (p.image||'')+'||'+(p.name||'');
          if(!collected.find(x => (x.image||'')+'||'+(x.name||'') === key)) collected.push(p);
        }
        // send incremental update to background so data persists mid-scroll
        if(found.length){
          console.debug('[content-script] sending incremental profiles', found.length);
          sendProfiles(found);
        }

        if(collected.length > lastCount){ lastCount = collected.length; noNew = 0; }
        else { noNew++; }

        // stop early if no new items seen for several steps
        if(noNew >= stopIfNoNew) break;

        // attempt to scroll the container element (usually the nearby UL's scrollable ancestor)
        try{
          if(container && typeof container.scrollTop === 'number' && container.scrollHeight && container.clientHeight){
            const prev = container.scrollTop;
            // prefer jumping near-one-viewport to force lazy-load
            container.scrollTop = Math.min(container.scrollTop + (container.clientHeight || window.innerHeight), Math.max(0, container.scrollHeight - (container.clientHeight || window.innerHeight)));
            // if no movement, nudge a bit
            if(container.scrollTop === prev){ container.scrollTop = Math.min(container.scrollTop + 150, Math.max(0, container.scrollHeight - (container.clientHeight || window.innerHeight))); }
          } else {
            // fallback to window scroll
            const prevY = window.scrollY || window.pageYOffset;
            window.scrollBy(0, Math.max(window.innerHeight * 0.8, 300));
          }
        }catch(e){ try{ window.scrollBy(0, Math.max(window.innerHeight * 0.8, 300)); }catch(_){} }

        // wait for new content to load and render
        await new Promise(r => setTimeout(r, stepDelay));
      }

      // final persist of collected set
      if(collected.length){ console.debug('[content-script] final send collected', collected.length); sendProfiles(collected); }
      console.debug('[content-script] scrollAndScrapeNearby finished', {collected: collected.length});
      return collected;
    }catch(err){ console.warn('scrollAndScrapeNearby failed', err); return []; }
  }

  // Guarded starter so we don't run multiple simultaneous scroll jobs
  let autoScrollRunning = false;
  function startAutoScrollIfNeeded(opts){
    try{
      if(autoScrollRunning) return;
      autoScrollRunning = true;
      // use defaults unless overridden
      const cfg = Object.assign({maxSteps:80, stepDelay:700, stopIfNoNew:6}, opts||{});
      scrollAndScrapeNearby(cfg).then(()=>{
        autoScrollRunning = false;
      }).catch((e)=>{ console.warn('auto scroll failed', e); autoScrollRunning = false; });
    }catch(e){ console.warn('startAutoScrollIfNeeded error', e); autoScrollRunning = false; }
  }

  // Allow external triggers (popup) to start the nearby scrape on demand
  try{
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      try{
        if(msg && msg.type === 'start_nearby_scrape'){
          startAutoScrollIfNeeded(msg.cfg || {});
          sendResponse({started: true});
          return true;
        }
      }catch(e){ console.warn('onMessage start_nearby_scrape error', e); }
    });
  }catch(e){ /* chrome.runtime may not be available in some contexts */ }

  // When the page URL is a people-nearby page, run once on load
  try{
    if(location && /people[-_]nearby|people-nearby|people\/nearby|nearby/.test(location.pathname+location.href)){
      // small delay to allow dynamic content to render, then start auto-scroll scraping
      setTimeout(()=>startAutoScrollIfNeeded(), 700);
    }
  }catch(e){}

  // Listen for clicks on the specific tab button, then scrape shortly after the click
  document.addEventListener('click', (ev) => {
    try{
      const btn = ev.target.closest && ev.target.closest(NEARBY_TAB_SELECTOR);
      if(btn){ setTimeout(()=>startAutoScrollIfNeeded(), 700); }
    }catch(e){}
  }, true);

  // Also observe mutations on #tabbar to detect the tab becoming active
  const tabbar = document.querySelector('#tabbar');
  if(tabbar){
    const mo = new MutationObserver((mutations)=>{
      for(const m of mutations){
        if(m.type === 'attributes' || m.addedNodes.length){
          // if nearby tab gains an "active" indicator, run
          const btn = document.querySelector(NEARBY_TAB_SELECTOR);
          if(btn && (btn.classList.contains('active') || btn.getAttribute('aria-pressed') === 'true' || btn.getAttribute('aria-selected') === 'true')){
            setTimeout(()=>startAutoScrollIfNeeded(), 500);
            return;
          }
        }
      }
    });
    try{ mo.observe(tabbar, {subtree:true, childList:true, attributes:true}); }catch(e){}
  }

  // Also run on navigation changes (single-page app) by listening to pushState/replaceState
  (function(history){
  const _push = history.pushState; history.pushState = function(){ _push.apply(this, arguments); setTimeout(()=>{ if(/people[-_]nearby|people-nearby|people\/nearby|nearby/.test(location.pathname+location.href)) startAutoScrollIfNeeded(); }, 600); };
  const _replace = history.replaceState; history.replaceState = function(){ _replace.apply(this, arguments); setTimeout(()=>{ if(/people[-_]nearby|people-nearby|people\/nearby|nearby/.test(location.pathname+location.href)) startAutoScrollIfNeeded(); }, 600); };
  window.addEventListener('popstate', ()=>{ if(/people[-_]nearby|people-nearby|people\/nearby|nearby/.test(location.pathname+location.href)) setTimeout(()=>startAutoScrollIfNeeded(), 600); });
  })(window.history);

})();
