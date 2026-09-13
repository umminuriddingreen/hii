import { buildWebCapture } from "./capture-payload.js";

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

async function settings() {
  const values = await chrome.storage.sync.get({ endpoint: DEFAULT_ENDPOINT, token: "" });
  return { endpoint: values.endpoint || DEFAULT_ENDPOINT, token: values.token || "" };
}

async function saveCapture(payload) {
  const { endpoint, token } = await settings();
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HII returned ${response.status}`);
  return data;
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.pageUrl || tab?.url || "";
  const title = tab?.title || url;
  const method = info.menuItemId === "save-selection-to-hii"
    ? "context-selection"
    : "context-page";
  const payload = buildWebCapture({
    url,
    title,
    method,
    selectedText: method === "context-selection" ? info.selectionText : undefined,
    tags: ["browser"]
  });
  saveCapture(payload).catch((error) => {
    console.warn("HII capture failed", error);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "save-capture") return false;
  saveCapture(message.payload)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
