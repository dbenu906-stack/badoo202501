// Minimal service worker file for Manifest V3.
// This extension performs extraction from the popup using chrome.scripting,
// so no heavy background logic is required. This file exists to satisfy MV3.

chrome.runtime.onInstalled.addListener(() => {
  // no-op for now
});
