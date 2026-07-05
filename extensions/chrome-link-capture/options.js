const DEFAULT_ENDPOINT = "http://localhost:3000/api/links";

document.addEventListener("DOMContentLoaded", async () => {
  const values = await chrome.storage.sync.get({ endpoint: DEFAULT_ENDPOINT });
  document.getElementById("endpoint").value = values.endpoint || DEFAULT_ENDPOINT;
});

document.getElementById("save").addEventListener("click", async () => {
  const endpoint = document.getElementById("endpoint").value.trim() || DEFAULT_ENDPOINT;
  await chrome.storage.sync.set({ endpoint });
  document.getElementById("status").textContent = "Saved.";
});
