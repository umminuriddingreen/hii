import { buildWebCapture } from "./capture-payload.js";

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function tagsFromInput(value) {
  return value.split(",").map((tag) => tag.trim()).filter(Boolean);
}

document.addEventListener("DOMContentLoaded", async () => {
  const tab = await activeTab();
  const title = document.getElementById("title");
  const url = document.getElementById("url");
  const save = document.getElementById("save");
  const status = document.getElementById("status");
  title.value = tab?.title || "";
  url.value = tab?.url || "";
  if (!/^https?:\/\//i.test(url.value)) {
    save.disabled = true;
    status.dataset.tone = "error";
    status.textContent = "Open a web page to save it to HII.";
  }
});

document.getElementById("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.getElementById("status");
  const save = document.getElementById("save");
  status.dataset.tone = "quiet";
  status.textContent = "Saving...";
  save.disabled = true;
  const payload = buildWebCapture({
    title: document.getElementById("title").value,
    url: document.getElementById("url").value,
    note: document.getElementById("note").value,
    tags: tagsFromInput(document.getElementById("tags").value),
    method: "extension-action"
  });
  const shareToAccount = document.getElementById("share-to-account").checked;
  chrome.runtime.sendMessage({ type: "save-capture", payload, shareToAccount }, (response) => {
    save.disabled = false;
    const runtimeError = chrome.runtime.lastError;
    if (response?.ok) {
      status.dataset.tone = "success";
      status.textContent = shareToAccount
        ? response.data?.accountShare?.shared
          ? "Saved locally and shared with your HII account."
          : "Saved locally. Account handoff is unavailable."
        : "Saved to your local HII workspace.";
    } else {
      status.dataset.tone = "error";
      status.textContent = runtimeError?.message || response?.error || "Could not save this page.";
    }
  });
});
