document.getElementById('sync').addEventListener('click', () => {
  const status = document.getElementById('status'); status.textContent = 'Syncing…';
  chrome.runtime.sendMessage({ type: 'sync-now' }, (response) => { status.textContent = response?.ok ? `Synced revision ${response.data.revision}.` : response?.error || 'Sync failed.'; });
});
chrome.storage.local.get({ lastSyncAt: '' }).then(({ lastSyncAt }) => { if (lastSyncAt) document.getElementById('status').textContent = `Last sync: ${new Date(lastSyncAt).toLocaleString()}`; });
