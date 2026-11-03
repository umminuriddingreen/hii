// SPDX-License-Identifier: Apache-2.0
// Portable library content contract. No instructions in this module are executable.
import { blake3 } from '@noble/hashes/blake3.js';
import { Decompress } from 'fzstd';
export type LibraryEntry = { id: string; name: string; kind: string; scope: string; head: string; archived: boolean };
export type LibrarySnapshot = { version: 1; items: LibraryEntry[]; versions: Array<{ id: string; hash: string; document: string }>; blobs: Record<string, number[]>; sources: Array<{ id: string; path: string; device: string; hash: string }> };
const enc = new TextEncoder(); const dec = new TextDecoder('utf-8', { fatal: true });
export const emptyLibrary = (): LibrarySnapshot => ({ version: 1, items: [], versions: [], blobs: {}, sources: [] });
export function hashBytes(bytes: Uint8Array) { return Array.from(blake3(bytes)).map(b => b.toString(16).padStart(2, '0')).join(''); }
const bytes = (data: Uint8Array) => new Uint8Array(data).buffer as ArrayBuffer;
const equalEntry = (a?: LibraryEntry, b?: LibraryEntry) => a?.id === b?.id && a?.head === b?.head && a?.archived === b?.archived && a?.scope === b?.scope && a?.kind === b?.kind && a?.name === b?.name;
function safePath(path: string) { return path.length > 0 && path.length <= 1024 && !/[\\:\0]/.test(path) && path.split('/').every(p => p && p !== '.' && p !== '..') && !path.split('/').some(p => /^\.env(?:\.|$)|credential|private-key|\.pem$|\.key$/i.test(p)); }
export function validateLibrary(state: LibrarySnapshot) {
  if (state.version !== 1 || !Array.isArray(state.items) || state.items.length > 1000 || !Array.isArray(state.versions) || !state.blobs || !Array.isArray(state.sources)) throw Error('Invalid library snapshot');
  let total = 0; for (const [hash, data] of Object.entries(state.blobs)) { if (!Array.isArray(data) || data.length > 64 * 1024 * 1024 || data.some(b => !Number.isInteger(b) || b < 0 || b > 255) || hashBytes(new Uint8Array(data)) !== hash) throw Error('Library attachment integrity failure'); total += data.length; }
  if (total > 512 * 1024 * 1024) throw Error('Library transfer exceeds limit');
  const seen = new Set<string>();
  for (const version of state.versions) {
    if (hashBytes(enc.encode(version.document)) !== version.hash) throw Error('Library version integrity failure');
    const v = JSON.parse(version.document); const names = new Set<string>();
    if (!Array.isArray(v.files) || !v.files.length || v.files.length > 512) throw Error('Invalid library bundle');
    let size = 0; for (const f of v.files) { if (typeof f.path !== 'string' || !safePath(f.path) || names.has(f.path) || state.blobs[f.hash]?.length !== f.size) throw Error('Invalid library bundle member'); names.add(f.path); size += f.size; }
    if (size > 128 * 1024 * 1024) throw Error('Bundle exceeds transfer limit');
  }
  for (const item of state.items) {
    if (seen.has(item.id) || !/^[a-f0-9-]{36}$/i.test(item.id) || !item.name?.trim() || item.name.length > 256 || !['skill', 'plugin', 'prompt', 'instruction', 'context'].includes(item.kind) || !(item.scope === 'global' || /^project:.{1,504}$/.test(item.scope))) throw Error('Invalid library metadata'); seen.add(item.id);
    const version = state.versions.find(v => v.id === item.id && v.hash === item.head); if (!version) throw Error('Library head version missing');
    const v = JSON.parse(version.document); if (v.name !== item.name || v.kind !== item.kind || v.scope !== item.scope) throw Error('Library metadata mismatch');
  }
  if (enc.encode(JSON.stringify(state)).length > 512 * 1024 * 1024) throw Error('Expanded library exceeds transfer limit');
}
export function mergeLibraries(local: LibrarySnapshot, remote: LibrarySnapshot, base: LibrarySnapshot) {
  validateLibrary(remote); const next = structuredClone(local);
  for (const incoming of remote.items) {
    const current = local.items.find(i => i.id === incoming.id); const before = base.items.find(i => i.id === incoming.id);
    if (equalEntry(current, incoming) || equalEntry(before, incoming)) continue;
    if (current && !equalEntry(current, before)) throw Error(`Library synchronization conflict: ${incoming.name}. Both versions remain preserved.`);
    next.items = next.items.filter(i => i.id !== incoming.id); next.items.push(incoming);
  }
  for (const version of remote.versions) if (!next.versions.some(v => v.id === version.id && v.hash === version.hash)) next.versions.push(version);
  Object.assign(next.blobs, remote.blobs);
  for (const source of remote.sources) if (!next.sources.some(s => s.id === source.id && s.path === source.path && s.device === source.device && s.hash === source.hash)) next.sources.push(source);
  return next;
}
export function libraryOperation(state: LibrarySnapshot, request: Record<string, unknown>) {
  const op = request.op; const id = String(request.id || ''); const entry = state.items.find(i => i.id === id);
  if (op === 'list') { const terms = String(request.query || '').toLowerCase().split(/\s+/).filter(Boolean); return { items: state.items.filter(i => (request.archived || !i.archived) && terms.every(t => JSON.stringify(detail(state, i)).toLowerCase().includes(t))) }; }
  if (op === 'doctor') return { items: state.items.length, verifiedBlobs: Object.keys(state.blobs).length, store: 'encrypted-browser-replica' };
  if (op === 'show') { if (!entry) throw Error('Library item not found'); return detail(state, entry, request.version as string | undefined); }
  if (op === 'bundle') { if (!entry) throw Error('Library item not found'); const v = version(state, entry); return { version: 1, entry, files: v.files.map((f: { path: string; hash: string }) => ({ path: f.path, bytes: state.blobs[f.hash] })) }; }
  if (op === 'archive' || op === 'restore') { if (!entry || entry.head !== request.expected) throw Error('Library version conflict'); entry.archived = op === 'archive'; return { entry }; }
  if (op !== 'save') throw Error('This library operation requires an enrolled desktop runtime');
  if (id && (!entry || entry.head !== request.expected || entry.kind !== request.kind || entry.scope !== request.scope)) throw Error('Library version or instruction scope conflict');
  const files = (request.files as Array<{ path: string; text?: string; base64?: string; bytes?: number[] }>).map(f => { const data = f.text !== undefined ? enc.encode(f.text) : f.base64 !== undefined ? Uint8Array.from(atob(f.base64), c => c.charCodeAt(0)) : new Uint8Array(f.bytes || []); const hash = hashBytes(data); state.blobs[hash] = Array.from(data); return { path: f.path, hash, size: data.length }; }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const raw = JSON.stringify({ name: request.name, kind: request.kind, scope: request.scope, parent: entry?.head || null, files }); const head = hashBytes(enc.encode(raw));
  const duplicate = !entry && state.items.find(i => i.kind === request.kind && i.scope === request.scope && JSON.stringify(version(state, i).files) === JSON.stringify(files)); if (duplicate) return { entry: duplicate };
  const next: LibraryEntry = { id: entry?.id || crypto.randomUUID(), name: String(request.name), kind: String(request.kind), scope: String(request.scope), head, archived: false };
  state.versions.push({ id: next.id, hash: head, document: raw }); state.items = state.items.filter(i => i.id !== next.id); state.items.push(next); validateLibrary(state); return { entry: next };
}
function version(state: LibrarySnapshot, entry: LibraryEntry, hash = entry.head) { const v = state.versions.find(v => v.id === entry.id && v.hash === hash); if (!v) throw Error('Library version missing'); return JSON.parse(v.document); }
function detail(state: LibrarySnapshot, entry: LibraryEntry, hash = entry.head) { const v = version(state, entry, hash); return { entry, viewedHash: hash, version: v, executable: false, files: v.files.map((f: { path: string; hash: string; size: number }) => { let text = null; try { if (f.size <= 1024 * 1024) text = dec.decode(new Uint8Array(state.blobs[f.hash])); } catch { /* Binary attachment. */ } return { ...f, text }; }), sources: state.sources.filter(s => s.id === entry.id), history: state.versions.filter(v => v.id === entry.id).map(v => ({ hash: v.hash, createdAt: 'Preserved version' })) }; }
export async function importLibraryKey(raw: { version: number; accountId: string; key: number[] }, account: string) {
  if (raw.version !== 1 || raw.accountId !== account || raw.key.length !== 32 || raw.key.some(b => !Number.isInteger(b) || b < 0 || b > 255)) throw Error('Library key belongs to another account or is invalid');
  return crypto.subtle.importKey('raw', bytes(new Uint8Array(raw.key)), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
export async function sealLibrary(key: CryptoKey, account: string, state: LibrarySnapshot) { validateLibrary(state); const nonce = crypto.getRandomValues(new Uint8Array(12)); const raw = enc.encode(JSON.stringify(state)); const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bytes(nonce), additionalData: bytes(enc.encode(`hii-library:v1:${account}`)) }, key, bytes(raw))); const packet = new Uint8Array(20 + cipher.length); packet.set(enc.encode('HII-LIB2')); packet.set(nonce, 8); packet.set(cipher, 20); return packet; }
export async function openLibrary(key: CryptoKey, account: string, packet: Uint8Array) {
  const magic = dec.decode(packet.slice(0, 8)); if (!['HII-LIB1', 'HII-LIB2'].includes(magic) || packet.length < 36 || packet.length > 256 * 1024 * 1024) throw Error('Invalid encrypted library packet');
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(packet.slice(8, 20)), additionalData: bytes(enc.encode(`hii-library:v1:${account}`)) }, key, bytes(packet.slice(20))));
  let raw = plain; if (magic === 'HII-LIB1') { const chunks: Uint8Array[] = []; let size = 0; const stream = new Decompress(chunk => { size += chunk.length; if (size > 512 * 1024 * 1024) throw Error('Expanded library exceeds limit'); chunks.push(chunk); }); stream.push(plain, true); raw = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; } }
  const result = JSON.parse(dec.decode(raw)) as LibrarySnapshot; validateLibrary(result); return result;
}
