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
  document.getElementById("title").value = tab?.title || "";
  document.getElementById("url").value = tab?.url || "";
});

document.getElementById("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.getElementById("status");
  status.textContent = "Saving...";
  const payload = buildWebCapture({
    title: document.getElementById("title").value,
    url: document.getElementById("url").value,
    note: document.getElementById("note").value,
    tags: tagsFromInput(document.getElementById("tags").value),
    method: "extension-action"
  });
  chrome.runtime.sendMessage({ type: "save-capture", payload }, (response) => {
    if (response?.ok) {
      status.textContent = "Saved to your HII workspace.";
    } else {
      status.textContent = response?.error || "Could not save link.";
    }
  });
});
