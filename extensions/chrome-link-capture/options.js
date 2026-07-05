const DEFAULT_ENDPOINT = "http://localhost:3000/api/links";

document.addEventListener("DOMContentLoaded", async () => {
  const values = await chrome.storage.sync.get({ endpoint: DEFAULT_ENDPOINT, token: "" });
  document.getElementById("endpoint").value = values.endpoint || DEFAULT_ENDPOINT;
  document.getElementById("token").value = values.token || "";
});

document.getElementById("save").addEventListener("click", async () => {
  const endpoint = document.getElementById("endpoint").value.trim() || DEFAULT_ENDPOINT;
  const token = document.getElementById("token").value.trim();
  await chrome.storage.sync.set({ endpoint, token });
  document.getElementById("status").textContent = "Saved.";
});
