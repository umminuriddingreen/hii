import { buildWebCapture } from "./capture-payload.js";

const NATIVE_HOST = "com.hii.save_to_hii";

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
  if (message?.type !== "save-capture") return false;
  saveCapture(message.payload)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
