// SPDX-License-Identifier: Apache-2.0
// Encrypted browser replica of CLI-owned library contracts. Account servers see ciphertext only.
import { emptyLibrary, importLibraryKey, libraryOperation, mergeLibraries, openLibrary, sealLibrary, type LibrarySnapshot } from '@/lib/library/replica';
type Account = { id: string; csrfToken: string };
type Cached = { id: string; key: CryptoKey; packet: ArrayBuffer; base: ArrayBuffer; revision: number; sequence: number };
let account: Account | null = null;
export function configureLibraryAccount(next: Account | null) { account = next; }
const buffer = (value: Uint8Array) => new Uint8Array(value).buffer as ArrayBuffer;
async function database() { return new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('hii-encrypted-library-v1', 1); r.onupgradeneeded = () => r.result.createObjectStore('accounts', { keyPath: 'id' }); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
async function cached(id: string) { const db = await database(); try { return await new Promise<Cached | undefined>((resolve, reject) => { const r = db.transaction('accounts').objectStore('accounts').get(id); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); } finally { db.close(); } }
async function persist(value: Cached, expected: number | null) {
  const db = await database(); try { await new Promise<void>((resolve, reject) => { const tx = db.transaction('accounts', 'readwrite'); const store = tx.objectStore('accounts'); const r = store.get(value.id); let conflict = false; r.onsuccess = () => { if ((r.result?.sequence ?? null) !== expected) { conflict = true; tx.abort(); } else store.put(value); }; tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(Error(conflict ? 'Library changed in another tab. Reload before saving.' : 'Encrypted library could not be saved.')); }); } finally { db.close(); }
}
function assertAccount(expected: Account) { if (account?.id !== expected.id) throw Error('HII account changed during library operation'); }
async function api(current: Account, path: string, init: RequestInit = {}) { assertAccount(current); const response = await fetch(`/api/library/${path}`, { credentials: 'same-origin', cache: 'no-store', ...init, headers: { 'X-HII-CSRF': current.csrfToken, ...(init.headers || {}) } }); assertAccount(current); if (!response.ok) throw Error(response.status === 401 ? 'HII account session expired. Local encrypted content remains preserved.' : response.status === 409 ? 'Account library changed; retry synchronization.' : 'Account library unavailable. Local edits remain queued.'); return response; }
async function sha256(bytes: Uint8Array) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer(bytes)))).map(b => b.toString(16).padStart(2, '0')).join(''); }
function canonical(state: LibrarySnapshot) { const value = structuredClone(state); value.items.sort((a, b) => a.id < b.id ? -1 : 1); value.versions.sort((a, b) => `${a.id}:${a.hash}` < `${b.id}:${b.hash}` ? -1 : 1); value.sources.sort((a, b) => `${a.id}:${a.path}:${a.device}` < `${b.id}:${b.path}:${b.device}` ? -1 : 1); return value; }
function same(a: unknown, b: unknown): boolean { if (a === b) return true; if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i])); if (a && b && typeof a === 'object' && typeof b === 'object') { const aa = a as Record<string, unknown>; const bb = b as Record<string, unknown>; return Object.keys(aa).length === Object.keys(bb).length && Object.keys(aa).every(k => same(aa[k], bb[k])); } return false; }
async function synchronize(current: Account, stored: Cached) {
  const remote = await (await api(current, 'index')).json(); if (remote.accountId !== current.id) throw Error('Account library identity mismatch');
  const local = await openLibrary(stored.key, current.id, new Uint8Array(stored.packet)); const base = await openLibrary(stored.key, current.id, new Uint8Array(stored.base));
  let incoming = base;
  if (remote.revision !== stored.revision && remote.manifest) {
    const manifest = remote.manifest; if (!Array.isArray(manifest.chunks) || !manifest.chunks.length || manifest.chunks.length > 256) throw Error('Invalid encrypted library manifest');
    const parts: Uint8Array[] = []; let length = 0;
    for (const hash of manifest.chunks) { if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw Error('Invalid chunk reference'); const bytes = new Uint8Array(await (await api(current, `chunks/${hash}`)).arrayBuffer()); if (bytes.length > 1024 * 1024 || await sha256(bytes) !== hash) throw Error('Encrypted chunk failed integrity verification'); length += bytes.length; parts.push(bytes); }
    const packet = new Uint8Array(length); let offset = 0; for (const p of parts) { packet.set(p, offset); offset += p.length; } if (await sha256(packet) !== manifest.sha256) throw Error('Encrypted library packet failed verification'); incoming = await openLibrary(stored.key, current.id, packet);
  }
  const merged = canonical(mergeLibraries(local, incoming, base)); let revision = remote.revision;
  if (!same(merged, canonical(incoming))) {
    const packet = await sealLibrary(stored.key, current.id, merged); if (packet.length > 256 * 1024 * 1024) throw Error('Library exceeds encrypted transfer limit'); const chunks = [];
    for (let offset = 0; offset < packet.length; offset += 1024 * 1024) { const part = packet.slice(offset, offset + 1024 * 1024); const hash = await sha256(part); await api(current, `chunks/${hash}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: buffer(part) }); chunks.push(hash); }
    revision = (await (await api(current, 'index', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: remote.revision, manifest: { version: 1, chunks, sha256: await sha256(packet) } }) })).json()).revision;
  }
  assertAccount(current); const packet = buffer(await sealLibrary(stored.key, current.id, merged)); const next = { ...stored, packet, base: packet, revision, sequence: stored.sequence + 1 }; await persist(next, stored.sequence); return next;
}
export async function hostedLibraryRequest(request: Record<string, unknown>): Promise<unknown> {
  const current = account; if (!current || !/^[A-Za-z0-9_-]{43}$/.test(current.id)) throw Error('Sign in to your HII account to open its encrypted library.');
  const work = async () => {
    let stored = await cached(current.id);
    if (request.op === 'unlock') {
      const key = await importLibraryKey(request.keyFile as Parameters<typeof importLibraryKey>[0], current.id);
      const state = stored ? await openLibrary(key, current.id, new Uint8Array(stored.packet)) : emptyLibrary(); const packet = buffer(await sealLibrary(key, current.id, state));
      const next: Cached = { id: current.id, key, packet, base: stored?.base || packet, revision: stored?.revision ?? 0, sequence: (stored?.sequence ?? 0) + 1 }; await persist(next, stored?.sequence ?? null); stored = next;
    }
    if (!stored) throw Error('Unlock this browser with a library key exported from an enrolled HII device. The key stays in this browser.');
    // Read refreshes pull new revisions. Network failures do not erase the offline replica.
    if (navigator.onLine && ['list', 'sync', 'unlock'].includes(String(request.op))) { try { stored = await synchronize(current, stored); } catch (error) { if (request.op === 'sync' || request.op === 'unlock') throw error; } }
    if (request.op === 'sync' || request.op === 'unlock') return { status: 'synced', revision: stored.revision };
    const state = await openLibrary(stored.key, current.id, new Uint8Array(stored.packet)); const result = libraryOperation(state, request); assertAccount(current);
    if (['save', 'archive', 'restore'].includes(String(request.op))) {
      const packet = buffer(await sealLibrary(stored.key, current.id, canonical(state))); const next = { ...stored, packet, sequence: stored.sequence + 1 }; await persist(next, stored.sequence);
      if (navigator.onLine) { try { await synchronize(current, next); } catch { /* The encrypted local commit remains the queued source of truth. */ } }
    } return result;
  };
  return navigator.locks ? navigator.locks.request(`hii-library:${current.id}`, work) : work();
}
