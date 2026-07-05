const DEFAULT_ENDPOINT = "http://localhost:3000/api/links";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "save-page-to-hii",
    title: "Save page to HII",
    contexts: ["page"]
  });
  chrome.contextMenus.create({
    id: "save-selection-to-hii",
    title: "Save selection to HII",
    contexts: ["selection"]
  });
});

async function endpoint() {
  const values = await chrome.storage.sync.get({ endpoint: DEFAULT_ENDPOINT });
  return values.endpoint || DEFAULT_ENDPOINT;
}

async function saveLink(payload) {
  const response = await fetch(await endpoint(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HII returned ${response.status}`);
  return data;
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.pageUrl || tab?.url || "";
  const title = tab?.title || url;
  const note = info.selectionText ? `Selection: ${info.selectionText.slice(0, 500)}` : "";
  saveLink({
    url,
    title,
    note,
    source: "chrome-context",
    tags: ["browser"]
  }).catch((error) => {
    console.warn("HII capture failed", error);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "save-link") return false;
  saveLink(message.payload)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
