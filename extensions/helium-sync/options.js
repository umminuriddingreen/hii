import { decryptVaultItem, encryptVaultItem } from './crypto.js';
const endpointDefault = 'http://127.0.0.1:3000/api/browser-sync';
const status = (message) => { document.getElementById('status').textContent = message; };

document.addEventListener('DOMContentLoaded', async () => {
  const values = await chrome.storage.local.get({ endpoint: endpointDefault, syncKey: '', browserName: '', syncHistory: true, syncTabs: false });
  for (const key of ['endpoint', 'syncKey', 'browserName']) document.getElementById(key).value = values[key];
  document.getElementById('syncHistory').checked = values.syncHistory;
  document.getElementById('syncTabs').checked = values.syncTabs;
});
document.getElementById('save').addEventListener('click', async () => {
  const syncKey = document.getElementById('syncKey').value;
  if (syncKey.length < 20) return status('Use a sync key of at least 20 characters.');
  await chrome.storage.local.set({ endpoint: document.getElementById('endpoint').value || endpointDefault, syncKey, browserName: document.getElementById('browserName').value || 'browser', syncHistory: document.getElementById('syncHistory').checked, syncTabs: document.getElementById('syncTabs').checked });
  status('Connection saved locally.');
});

function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"' && quoted && text[index + 1] === '"') { field += '"'; index++; }
    else if (character === '"') quoted = !quoted;
    else if (character === ',' && !quoted) { row.push(field); field = ''; }
    else if ((character === '\n' || character === '\r') && !quoted) { if (character === '\r' && text[index + 1] === '\n') index++; row.push(field); if (row.some(Boolean)) rows.push(row); row = []; field = ''; }
    else field += character;
  }
  row.push(field); if (row.some(Boolean)) rows.push(row);
  const headers = rows.shift()?.map((value) => value.trim().toLowerCase()) || [];
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
}

async function unlock() {
  const password = document.getElementById('master').value;
  if (password.length < 12) throw new Error('Master password must be at least 12 characters.');
  const { vaultRecords = [] } = await chrome.storage.local.get({ vaultRecords: [] });
  const items = [];
  for (const record of vaultRecords.filter((entry) => !entry.deleted)) items.push(await decryptVaultItem(record.value, password));
  await chrome.runtime.sendMessage({ type: 'set-unlocked-vault', items });
  document.getElementById('vault').textContent = `${items.length} login(s) unlocked for this browser session.`;
  return { password, items };
}
document.getElementById('unlock').addEventListener('click', () => unlock().then(() => status('Vault unlocked until the browser closes.')).catch((error) => status(error.message)));
document.getElementById('lock').addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'set-unlocked-vault', items: [] }); document.getElementById('master').value = ''; document.getElementById('vault').textContent = ''; status('Vault locked.'); });
document.getElementById('import').addEventListener('click', async () => {
  try {
    const file = document.getElementById('csv').files[0]; if (!file) throw new Error('Choose a CSV file first.');
    const password = document.getElementById('master').value; if (password.length < 12) throw new Error('Use a master password of at least 12 characters.');
    const rows = parseCsv(await file.text());
    const stored = await chrome.storage.local.get({ vaultRecords: [] });
    const records = new Map(stored.vaultRecords.map((record) => [record.id, record]));
    for (const row of rows) {
      const url = row.url || row.origin || ''; const username = row.username || ''; const secret = row.password || '';
      if (!url || !secret) continue;
      const origin = new URL(url).origin; const idBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${origin}\0${username}`));
      const id = Array.from(new Uint8Array(idBytes)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
      records.set(id, { id, modifiedAt: Date.now(), value: await encryptVaultItem({ name: row.name || origin, origin, username, password: secret }, password) });
    }
    await chrome.storage.local.set({ vaultRecords: [...records.values()] }); await unlock(); status(`Encrypted vault now contains ${records.size} login(s). Sync now from the toolbar.`);
  } catch (error) { status(error.message); }
});
