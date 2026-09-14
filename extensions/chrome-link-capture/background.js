import { buildWebCapture } from "./capture-payload.js";

const NATIVE_HOST = "com.hii.save_to_hii";
const PAGE_SCRIPT = "hii-page-index";

async function indexEnabled() {
  const state = await chrome.storage.local.get({ pageIndexEnabled: false });
  return state.pageIndexEnabled === true;
}

async function registerPageIndex() {
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [PAGE_SCRIPT] });
  if (registered.length) return;
  await chrome.scripting.registerContentScripts([{
    id: PAGE_SCRIPT,
    matches: ["http://*/*", "https://*/*"],
    js: ["page-index.js"],
    runAt: "document_idle",
    persistAcrossSessions: true
  }]);
}

async function disablePageIndex() {
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [PAGE_SCRIPT] });
  if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [PAGE_SCRIPT] });
  await chrome.storage.local.set({ pageIndexEnabled: false });
}

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

chrome.runtime.onStartup.addListener(async () => {
  if (await indexEnabled()) await registerPageIndex();
});

function sendNative(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "HII native host did not accept the capture."));
        return;
      }
      resolve(response.data);
    });
  });
}

async function saveCapture(payload) {
  return sendNative({ type: "save-capture", payload });
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
  if (message?.type === "enable-page-index") {
    chrome.storage.local.set({ pageIndexEnabled: true })
      .then(registerPageIndex)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "disable-page-index") {
    disablePageIndex()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "index-page") {
    const page = message.page;
    if (!_sender.tab || _sender.tab.incognito || !/^https?:\/\//.test(page?.url || "") ||
        page.url !== _sender.tab.url || typeof page.text !== "string" || page.text.length > 500_000 ||
        page.text.length < 40) return false;
    indexEnabled()
      .then((enabled) => {
        if (!enabled) throw new Error("Page indexing is off");
        const sourceUrl = new URL(page.url);
        sourceUrl.username = "";
        sourceUrl.password = "";
        sourceUrl.search = "";
        sourceUrl.hash = "";
        return saveCapture(buildWebCapture({
          url: sourceUrl.toString(),
          title: page.title || _sender.tab.title || page.url,
          method: "extension-page-index",
          contentText: page.text,
          tags: ["browser", "page-index"]
        }));
      })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type !== "save-capture") return false;
  saveCapture(message.payload)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
