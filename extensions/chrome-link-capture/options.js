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
