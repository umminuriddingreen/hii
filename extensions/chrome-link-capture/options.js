const NATIVE_HOST = "com.hii.save_to_hii";
const PAGE_ORIGINS = ["http://*/*", "https://*/*"];
const permissionSpecs = {
  bookmarks: { request: { permissions: ["bookmarks"] }, remove: { permissions: ["bookmarks"] } },
  history: { request: { permissions: ["history"] }, remove: { permissions: ["history"] } },
  tabs: { request: { permissions: ["tabs"] }, remove: { permissions: ["tabs"] } },
  pageText: {
    request: { permissions: ["tabs", "scripting"], origins: PAGE_ORIGINS },
    remove: { permissions: ["scripting"], origins: PAGE_ORIGINS }
  }
};

function permissionCall(method, query) {
  return new Promise((resolve, reject) => {
    chrome.permissions[method](query, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

async function refreshPermissions() {
  for (const input of document.querySelectorAll("[data-permission]")) {
    const spec = permissionSpecs[input.dataset.permission];
    input.checked = await permissionCall("contains", spec.remove);
  }
}

for (const input of document.querySelectorAll("[data-permission]")) {
  input.addEventListener("change", async () => {
    const status = document.getElementById("import-status");
    const spec = permissionSpecs[input.dataset.permission];
    input.disabled = true;
    try {
      const changed = await permissionCall(input.checked ? "request" : "remove", input.checked ? spec.request : spec.remove);
      status.dataset.tone = changed || !input.checked ? "success" : "quiet";
      status.textContent = input.checked && !changed
        ? "Chrome did not grant that source. Nothing was read."
        : input.checked
          ? "Permission enabled. Press Import when you want HII to read it."
          : "Permission removed. Future imports will skip that source.";
    } catch (error) {
      status.dataset.tone = "error";
      status.textContent = error.message;
    } finally {
      input.disabled = false;
      await refreshPermissions();
    }
  });
}

document.getElementById("check").addEventListener("click", () => {
  const status = document.getElementById("status");
  status.textContent = "Checking native host...";
  chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: "ping" }, (response) => {
    const error = chrome.runtime.lastError;
    if (error) {
      status.dataset.tone = "error";
      status.textContent = `Native host is not registered: ${error.message}`;
      return;
    }
    status.dataset.tone = response?.ok ? "success" : "error";
    status.textContent = response?.ok
      ? "HII Companion is connected to the local HII runtime."
      : `Native host responded with: ${response?.error || "unknown error"}`;
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "browser-import-progress") return;
  const status = document.getElementById("import-status");
  status.dataset.tone = message.progress?.phase === "complete" ? "success" : "quiet";
  status.textContent = message.progress?.message || "Importing…";
});

document.getElementById("import").addEventListener("click", () => {
  const button = document.getElementById("import");
  const status = document.getElementById("import-status");
  const report = document.getElementById("import-report");
  button.disabled = true;
  report.hidden = true;
  status.dataset.tone = "quiet";
  status.textContent = "Starting local import…";
  chrome.runtime.sendMessage({ type: "import-browser-library" }, (response) => {
    button.disabled = false;
    const error = chrome.runtime.lastError;
    if (error || !response?.ok) {
      status.dataset.tone = "error";
      status.textContent = error?.message || response?.error || "Browser import failed.";
      return;
    }
    const value = response.report;
    status.dataset.tone = "success";
    status.textContent = `Saved ${value.imported} local records; ${value.unchanged} already existed; ${value.failed} failed.`;
    report.hidden = false;
    report.textContent = JSON.stringify({
      available: value.available,
      prepared: value.prepared,
      imported: value.imported,
      unchanged: value.unchanged,
      failed: value.failed,
      excluded: value.excluded,
      localOnly: value.localOnly
    }, null, 2);
  });
});

refreshPermissions().catch((error) => {
  const status = document.getElementById("import-status");
  status.dataset.tone = "error";
  status.textContent = error.message;
});
