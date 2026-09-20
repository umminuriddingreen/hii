// SPDX-License-Identifier: LicenseRef-BSL-1.1

// This script is registered only after the user grants website access in Options.
const MIN_INTERVAL_MS = 20_000;
const MAX_TEXT_CHARS = 500_000;
let lastText = "";
let lastSentAt = 0;
let timer;

function eligiblePage() {
  if (!/^https?:$/.test(location.protocol)) return false;
  if (document.querySelector('input[type="password"], input[autocomplete="cc-number"], input[autocomplete="one-time-code"]')) return false;
  return !/(?:^|[./_-])(login|signin|sign-in|checkout|payment)(?:$|[/?#._-])/i.test(location.pathname);
}

function visibleText() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const pieces = [];
  let length = 0;
  let visited = 0;
  while (walker.nextNode() && length < MAX_TEXT_CHARS && visited++ < 30_000) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (!parent || parent.closest('form, [contenteditable], input, textarea, select, script, style, noscript') || !parent.getClientRects().length) continue;
    const value = node.textContent?.trim();
    if (!value) continue;
    pieces.push(value);
    length += value.length + 1;
  }
  return pieces.join(" ").slice(0, MAX_TEXT_CHARS);
}

function capture() {
  if (!eligiblePage()) return;
  const text = document.body ? visibleText() : "";
  if (text.length < 40 || text === lastText) return;
  const now = Date.now();
  if (now - lastSentAt < MIN_INTERVAL_MS) {
    schedule(MIN_INTERVAL_MS - (now - lastSentAt));
    return;
  }
  lastText = text;
  lastSentAt = now;
  chrome.runtime.sendMessage({
    type: "index-page",
    page: { url: location.href, title: document.title, text }
  }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      // Retry after a disconnected native host; do not flood it on DOM changes.
      lastText = "";
      schedule(MIN_INTERVAL_MS);
    }
  });
}

function schedule(delay = 1500) {
  clearTimeout(timer);
  timer = setTimeout(capture, delay);
}

new MutationObserver(() => schedule()).observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true
});
window.addEventListener("pageshow", () => schedule());
schedule();
