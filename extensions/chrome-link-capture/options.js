const NATIVE_HOST = "com.hii.save_to_hii";

document.getElementById("check").addEventListener("click", () => {
  const status = document.getElementById("status");
  status.textContent = "Checking native host...";
  chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: "ping" }, (response) => {
    const error = chrome.runtime.lastError;
    if (error) {
      status.textContent = `Native host is not registered: ${error.message}`;
      return;
    }
    status.textContent = response?.ok
      ? "Native host responded."
      : `Native host responded with: ${response?.error || "unknown error"}`;
  });
});

const ORIGINS = ["http://*/*", "https://*/*"];
const indexStatus = document.getElementById("index-status");
const browserName = document.getElementById("browser-name");

chrome.storage.local.get({ browserName: "Chrome" }).then((settings) => {
  browserName.value = settings.browserName;
});
browserName.addEventListener("change", () => {
  chrome.storage.local.set({ browserName: browserName.value });
});

async function refresh() {
  const { pageIndexEnabled = false } = await chrome.storage.local.get({ pageIndexEnabled: false });
  indexStatus.textContent = pageIndexEnabled ? "Page indexing is on." : "Page indexing is paused.";
}

function command(type) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.ok) return reject(new Error(response?.error || "HII did not accept the change"));
      resolve();
    });
  });
}

document.getElementById("enable-index").addEventListener("click", async () => {
  try {
    if (!await chrome.permissions.request({ origins: ORIGINS })) {
      indexStatus.textContent = "Website access was not granted.";
      return;
    }
    await command("enable-page-index");
    await refresh();
  } catch (error) {
    indexStatus.textContent = error.message;
  }
});

document.getElementById("disable-index").addEventListener("click", async () => {
  try {
    await command("disable-page-index");
    await chrome.permissions.remove({ origins: ORIGINS });
    await refresh();
  } catch (error) {
    indexStatus.textContent = error.message;
  }
});

refresh();
