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

  function extractProfilesFromDOM(){
    const out = [];
    const seen = new Set();

    // Prefer structured people-nearby list if present (use class-based selectors you provided)
    try{
      const nearbyList = document.querySelector('div.people-nearby__content');
      if(nearbyList){
        const items = nearbyList.querySelectorAll('ul > li, ul li');
        if(items && items.length){
          for(const it of items){
            try{
              // name and age elements use csms-profile-info__name / __age
              // prefer explicit attributes/classes present in the nearby list
              const btn = it.querySelector('button[data-qa-user-id]') || it.querySelector('button');
              const userId = btn ? btn.getAttribute('data-qa-user-id') || '' : '';
              const nameInner = it.querySelector('.csms-profile-info__name-inner') || it.querySelector('[data-qa="profile-info__name"]');
              const ageEl = it.querySelector('[data-qa="profile-info__age"]') || it.querySelector('.csms-profile-info__age');
              const imgEl = it.querySelector('.csms-avatar__image') || it.querySelector('.csms-user-list-cell__media img') || it.querySelector('img');
              const name = nameInner ? nameInner.innerText.trim() : getNameFromElement(it);
              let image = imgEl ? (imgEl.src || imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '') : getImageFromElement(it);
              const age = ageEl ? (ageEl.innerText || ageEl.textContent || '').trim().replace(/^,\s*/,'') : '';
              // normalize protocol-relative URLs
              if(image && image.startsWith('//')) image = window.location.protocol + image;
              // dedupe by stable user id when available, otherwise by image+name
              const key = userId ? ('id:'+userId) : ((image||'') + '||' + (name||''));
              if(!name && !image) continue;
              if(seen.has(key)) continue;
              seen.add(key);
              out.push({id: userId||'', name: name||'', age: age||'', image: image||''});
            }catch(e){ /* ignore item errors */ }
          }
          // return prioritized results (images + name first)
          out.sort((a,b)=>{ const wa = (a.image?1:0)+(a.name?1:0); const wb = (b.image?1:0)+(b.name?1:0); return wb-wa; });
          return out.slice(0, 500);
        }
      }
    }catch(e){ console.warn('nearby list extraction failed', e); }

    // Fallback heuristics if structured list not present
    const candidates = Array.from(document.querySelectorAll('article, a, div, li'));
    for(const c of candidates){
      // skip tiny nodes
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
    // Prioritize items that include images and have some name
    out.sort((a,b)=>{ const wa = (a.image?1:0)+(a.name?1:0); const wb = (b.image?1:0)+(b.name?1:0); return wb-wa; });
    // Limit to a reasonable number
    return out.slice(0, 500);
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
      const nearbyList = document.querySelector('div.people-nearby__content');
      const container = nearbyList ? (nearbyList.querySelector('ul') || nearbyList) : document.scrollingElement || document.documentElement || window;
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

        // attempt to scroll the container: if it's an element, adjust scrollTop else use window scrollBy
        try{
          if(container && container.scrollHeight && container.clientHeight){
            // scroll by one viewport
            const prev = container.scrollTop;
            container.scrollTop = Math.min(container.scrollTop + container.clientHeight, container.scrollHeight - container.clientHeight);
            // if no movement, try to scroll small amount
            if(container.scrollTop === prev){ container.scrollTop = Math.min(container.scrollTop + 100, container.scrollHeight - container.clientHeight); }
          } else {
            // window scroll
            const prevY = window.scrollY || window.pageYOffset;
            window.scrollBy({top: Math.max(window.innerHeight * 0.8, 300), left: 0, behavior: 'smooth'});
            // ensure some time for smooth scroll
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
