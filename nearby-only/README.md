Badoo Nearby Scraper - Minimal

What this extension does
- Injects a content script into Badoo pages and automatically scrapes the Nearby grid (`ul.csms-user-list`).
- Extracts: user id (from `data-qa-user-id`), name, age and a primary image URL when available.
- Auto-scrolls the list to force lazy-loading and persists results to `chrome.storage.local.nearby_only_profiles`.

How to load
1. In Chrome/Edge, open chrome://extensions and enable Developer mode.
2. Click "Load unpacked" and select the `nearby-only` directory.

How to run
- The script auto-starts when you open the Nearby page or click the Nearby tab.
- You can manually start from the page console:
  chrome.runtime.sendMessage({ type: 'start_nearby_only', cfg: { maxSteps: 200, stepDelay: 700 } });

Notes
- This is a minimal, focused extension. It intentionally does not include a popup UI.
- If the page uses touch-only lazy-loading, adjust stepDelay or implement a click-through routine.
