import { buildWebCapture } from "./capture-payload.js";
import {
  MAX_HISTORY_RESULTS,
  PAGE_ORIGINS,
  buildLibraryCapture,
  chunks,
  extractVisiblePageText,
  flattenBookmarks,
  inspectImportUrl
} from "./browser-library.js";

const NATIVE_HOST = "com.hii.save_to_hii";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "save-page-to-hii",
      title: "Save page to HII",
      contexts: ["page"],
      documentUrlPatterns: ["http://*/*", "https://*/*"]
    });
    chrome.contextMenus.create({
      id: "save-selection-to-hii",
      title: "Save selection to HII",
      contexts: ["selection"],
      documentUrlPatterns: ["http://*/*", "https://*/*"]
    });
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

async function saveCapture(payload, shareToAccount = false) {
  return sendNative({ type: "save-capture", payload, shareToAccount });
}

function chromeCallback(invoke) {
  return new Promise((resolve, reject) => {
    invoke((result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

async function hasPermission(query) {
  return chromeCallback((done) => chrome.permissions.contains(query, done));
}

function reportProgress(progress) {
  chrome.runtime.sendMessage({ type: "browser-import-progress", progress }, () => {
    void chrome.runtime.lastError;
  });
}

function addExclusion(report, reason, count = 1) {
  if (count < 1) return;
  report.excluded[reason] = (report.excluded[reason] || 0) + count;
}

async function addCapture(captures, report, input) {
  const result = await buildLibraryCapture(input);
  if (result.excluded) addExclusion(report, result.excluded);
  else captures.push(result.payload);
}

async function importBrowserLibrary() {
  const report = {
    localOnly: true,
    available: { bookmarks: 0, history: 0, tabs: 0, pageText: 0 },
    prepared: 0,
    imported: 0,
    unchanged: 0,
    failed: 0,
    excluded: {}
  };
  const captures = [];
  const observedAt = new Date().toISOString();
  const [bookmarksAllowed, historyAllowed, tabsAllowed, pageTextAllowed] = await Promise.all([
    hasPermission({ permissions: ["bookmarks"] }),
    hasPermission({ permissions: ["history"] }),
    hasPermission({ permissions: ["tabs"] }),
    hasPermission({ permissions: ["scripting"], origins: PAGE_ORIGINS })
  ]);

  reportProgress({ phase: "collecting", message: "Reading only the browser sources you enabled…" });

  if (bookmarksAllowed) {
    const tree = await chromeCallback((done) => chrome.bookmarks.getTree(done));
    const bookmarks = flattenBookmarks(tree);
    report.available.bookmarks = bookmarks.length;
    for (const bookmark of bookmarks) {
      await addCapture(captures, report, {
        category: "bookmark",
        url: bookmark.url,
        title: bookmark.title,
        observedAt,
        itemTimestamp: bookmark.dateLastUsed || bookmark.dateAdded,
        metadata: {
          provenance: "Chrome bookmark",
          folder: bookmark.folderPath,
          dateAdded: bookmark.dateAdded ? new Date(bookmark.dateAdded).toISOString() : undefined,
          dateLastUsed: bookmark.dateLastUsed ? new Date(bookmark.dateLastUsed).toISOString() : undefined,
          browserBookmarkId: bookmark.id
        }
      });
    }
  }

  if (historyAllowed) {
    const history = await chromeCallback((done) => chrome.history.search({
      text: "",
      startTime: 0,
      maxResults: MAX_HISTORY_RESULTS
    }, done));
    report.available.history = history.length;
    if (history.length === MAX_HISTORY_RESULTS) addExclusion(report, "history_result_limit_reached");
    for (const item of history) {
      await addCapture(captures, report, {
        category: "history",
        url: item.url,
        title: item.title,
        observedAt,
        itemTimestamp: item.lastVisitTime,
        metadata: {
          provenance: "Chrome history",
          lastVisitTime: item.lastVisitTime ? new Date(item.lastVisitTime).toISOString() : undefined,
          visitCount: item.visitCount,
          typedCount: item.typedCount
        }
      });
    }
  }

  let tabs = [];
  if (tabsAllowed) {
    tabs = await chromeCallback((done) => chrome.tabs.query({ windowType: "normal" }, done));
    const ordinaryTabs = tabs.filter((tab) => !tab.incognito);
    addExclusion(report, "incognito", tabs.length - ordinaryTabs.length);
    tabs = ordinaryTabs;
    report.available.tabs = tabs.length;
    for (const tab of tabs) {
      await addCapture(captures, report, {
        category: "open-tab",
        url: tab.url,
        title: tab.title,
        observedAt,
        itemTimestamp: tab.lastAccessed,
        metadata: {
          provenance: "Chrome open-tab inventory",
          browserTabId: tab.id,
          windowId: tab.windowId,
          tabIndex: tab.index,
          pinned: tab.pinned,
          audible: tab.audible,
          discarded: tab.discarded,
          status: tab.status,
          lastAccessed: tab.lastAccessed ? new Date(tab.lastAccessed).toISOString() : undefined
        }
      });
    }
  }

  if (pageTextAllowed && !tabsAllowed) {
    addExclusion(report, "page_text_requires_open_tabs_permission");
  } else if (pageTextAllowed) {
    for (let index = 0; index < tabs.length; index += 1) {
      const tab = tabs[index];
      const decision = inspectImportUrl(tab.url || "");
      if (!decision.allowed) {
        addExclusion(report, decision.reason);
        continue;
      }
      reportProgress({
        phase: "reading-pages",
        current: index + 1,
        total: tabs.length,
        message: `Reading visible text from approved tab ${index + 1} of ${tabs.length}…`
      });
      try {
        const frames = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: extractVisiblePageText,
          args: [80_000]
        });
        const result = frames?.[0]?.result;
        if (!result?.ok) {
          addExclusion(report, result?.reason || "page_unreadable");
          continue;
        }
        report.available.pageText += 1;
        await addCapture(captures, report, {
          category: "page-text",
          url: decision.url,
          title: tab.title,
          observedAt,
          itemTimestamp: tab.lastAccessed,
          text: result.text,
          metadata: {
            provenance: "Visible text from an open Chrome tab",
            browserTabId: tab.id,
            capturedAt: tab.lastAccessed ? new Date(tab.lastAccessed).toISOString() : observedAt
          }
        });
      } catch {
        addExclusion(report, "page_unreadable");
      }
    }
  }

  const unique = [...new Map(captures.map((payload) => [payload.captureId, payload])).values()];
  report.prepared = unique.length;
  const batches = chunks(unique);
  for (let index = 0; index < batches.length; index += 1) {
    reportProgress({
      phase: "saving",
      current: index + 1,
      total: batches.length,
      message: `Saving local batch ${index + 1} of ${batches.length}…`
    });
    const result = await sendNative({ type: "import-browser-library", payloads: batches[index] });
    report.imported += result.imported || 0;
    report.unchanged += result.unchanged || 0;
    report.failed += result.failed || 0;
  }
  reportProgress({ phase: "complete", message: "Browser context import complete.", report });
  return report;
}

let activeImport = null;

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.pageUrl || tab?.url || "";
  if (!/^https?:\/\//i.test(url)) return;
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
  if (message?.type === "import-browser-library") {
    if (!activeImport) {
      activeImport = importBrowserLibrary().finally(() => { activeImport = null; });
    }
    activeImport
      .then((report) => sendResponse({ ok: true, report }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type !== "save-capture") return false;
  saveCapture(message.payload, message.shareToAccount === true)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
