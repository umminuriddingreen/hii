const DEFAULT_ENDPOINT = 'http://127.0.0.1:3000/api/browser-sync';

async function settings() {
  return chrome.storage.local.get({ endpoint: DEFAULT_ENDPOINT, syncKey: '', browserName: 'browser', syncHistory: true, syncTabs: false });
}

async function localRecords() {
  const config = await settings();
  const now = Date.now();
  const bookmarks = [];
  const walk = (nodes, trail = []) => nodes.forEach((node) => {
    if (node.url) bookmarks.push({ id: node.url, modifiedAt: Number(node.dateAdded || now), value: { title: node.title, url: node.url, path: trail } });
    if (node.children) walk(node.children, node.title ? [...trail, node.title] : trail);
  });
  walk(await chrome.bookmarks.getTree());
  const history = config.syncHistory ? (await chrome.history.search({ text: '', startTime: 0, maxResults: 10000 }))
    .filter((item) => item.url).map((item) => ({ id: item.url, modifiedAt: Number(item.lastVisitTime || now), value: { title: item.title, url: item.url } })) : [];
  const tabs = config.syncTabs ? (await chrome.tabs.query({})).filter((tab) => tab.url?.startsWith('http'))
    .map((tab) => ({ id: tab.url, modifiedAt: now, value: { title: tab.title, url: tab.url } })) : [];
  const stored = await chrome.storage.local.get({ vaultRecords: [] });
  return { bookmarks, history, tabs, vault: stored.vaultRecords };
}

async function applyRemote(document) {
  const config = await settings();
  const marker = 'HII Sync';
  const existingFolders = await chrome.bookmarks.search({ title: marker });
  const folder = existingFolders.find((item) => !item.url) || await chrome.bookmarks.create({ title: marker });
  const existing = new Set((await chrome.bookmarks.getChildren(folder.id)).map((item) => item.url));
  for (const record of Object.values(document.collections.bookmarks || {})) {
    if (!record.deleted && record.value?.url && !existing.has(record.value.url)) await chrome.bookmarks.create({ parentId: folder.id, title: record.value.title || record.value.url, url: record.value.url });
  }
  if (config.syncHistory) for (const record of Object.values(document.collections.history || {})) {
    if (!record.deleted && record.value?.url) await chrome.history.addUrl({ url: record.value.url });
  }
  const localVault = await chrome.storage.local.get({ vaultRecords: [] });
  const mergedVault = new Map(localVault.vaultRecords.map((record) => [record.id, record]));
  for (const record of Object.values(document.collections.vault || {})) if (!mergedVault.get(record.id) || mergedVault.get(record.id).modifiedAt < record.modifiedAt) mergedVault.set(record.id, record);
  await chrome.storage.local.set({ vaultRecords: [...mergedVault.values()], lastSyncAt: new Date().toISOString(), revision: document.revision });
}

async function syncNow() {
  const config = await settings();
  if (!config.syncKey || config.syncKey.length < 20) throw new Error('Set a sync key of at least 20 characters in Options.');
  const headers = { 'content-type': 'application/json', 'x-hii-sync-key': config.syncKey };
  const post = await fetch(config.endpoint, { method: 'POST', headers, body: JSON.stringify({ collections: await localRecords() }) });
  const document = await post.json();
  if (!post.ok) throw new Error(document.error || `HII returned ${post.status}`);
  await applyRemote(document);
  return { revision: document.revision, updatedAt: document.updatedAt };
}

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('hii-sync', { periodInMinutes: 15 }));
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'hii-sync') syncNow().catch(console.warn); });
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === 'sync-now') { syncNow().then((data) => respond({ ok: true, data })).catch((error) => respond({ ok: false, error: error.message })); return true; }
  if (message?.type === 'vault-candidates') {
    chrome.storage.session.get({ unlockedVault: [] }).then(({ unlockedVault }) => respond({ ok: true, items: unlockedVault.filter((item) => message.origin.startsWith(item.origin)) }));
    return true;
  }
  if (message?.type === 'set-unlocked-vault') { chrome.storage.session.set({ unlockedVault: message.items }).then(() => respond({ ok: true })); return true; }
  return false;
});
