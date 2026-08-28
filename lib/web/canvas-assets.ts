// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { seedFromFile, type NodeSeed } from '@/lib/workspace/ingest';
import type { WorkspaceDoc, WorkspaceNode } from '@/lib/workspace/types';

const DATABASE = 'hii-web-canvas-assets-v1';
const STORE = 'assets';
const VERSION = 1;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_BATCH_BYTES = 128 * 1024 * 1024;
const MAX_BATCH_FILES = 12;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{43}$/;

type BrowserCanvasAsset = {
  id: string;
  accountId: string;
  name: string;
  mime: string;
  size: number;
  lastModified: number;
  sha256: string;
  bytes: ArrayBuffer;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('canvas_asset_storage_unavailable'));
    request.onblocked = () => reject(new Error('canvas_asset_storage_blocked'));
  });
}

function transaction<T>(mode: IDBTransactionMode, perform: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDatabase().then((database) => new Promise<T>((resolve, reject) => {
    const tx = database.transaction(STORE, mode);
    const request = perform(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('canvas_asset_storage_failed'));
    tx.oncomplete = () => database.close();
    tx.onabort = () => { database.close(); reject(tx.error ?? new Error('canvas_asset_storage_failed')); };
  }));
}

async function digest(bytes: ArrayBuffer) {
  const value = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertAccount(accountId: string) {
  if (!ACCOUNT_ID.test(accountId)) throw new TypeError('invalid_canvas_account');
}

async function prepareAsset(accountId: string, file: File): Promise<BrowserCanvasAsset> {
  assertAccount(accountId);
  if (file.size > MAX_FILE_BYTES) throw new RangeError('canvas_asset_too_large');
  const bytes = await file.arrayBuffer();
  const sha256 = await digest(bytes);
  const asset: BrowserCanvasAsset = {
    id: `${accountId}:${crypto.randomUUID()}`,
    accountId,
    name: file.name || 'untitled',
    mime: file.type,
    size: file.size,
    lastModified: file.lastModified,
    sha256,
    bytes,
  };
  return asset;
}

async function storeAssets(assets: BrowserCanvasAsset[]) {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const asset of assets) store.put(asset);
    tx.oncomplete = () => { database.close(); resolve(); };
    tx.onabort = () => { database.close(); reject(tx.error ?? new Error('canvas_asset_storage_failed')); };
    tx.onerror = () => { /* onabort owns the single rejection and cleanup */ };
  });
}

async function readAsset(accountId: string, id: string) {
  assertAccount(accountId);
  const asset = await transaction<BrowserCanvasAsset | undefined>('readonly', (store) => store.get(id));
  return asset?.accountId === accountId ? asset : undefined;
}

function withAsset(seed: NodeSeed, asset: BrowserCanvasAsset): NodeSeed {
  const viewable = ['image', 'document', 'media', 'model', 'cad'].includes(seed.type);
  const url = viewable ? URL.createObjectURL(new Blob([asset.bytes], { type: asset.mime || 'application/octet-stream' })) : undefined;
  return {
    ...seed,
    object: {
      ...(seed.object ?? { kind: 'asset' as const }),
      owner: 'human',
      status: 'ready',
      source: `indexeddb:${asset.id}`,
      proofRefs: [`sha256:${asset.sha256}`],
      audit: [
        ...(seed.object?.audit ?? []),
        { ts: new Date().toISOString(), actor: 'human' as const, action: 'stored canvas asset on this browser device' },
      ].slice(-20),
    },
    payload: {
      ...seed.payload,
      ...(url ? { url } : {}),
      browserAssetId: asset.id,
      path: `indexeddb:${asset.id}`,
      name: asset.name,
      mime: asset.mime,
      size: asset.size,
      sha256: asset.sha256,
      ephemeral: false,
    },
  };
}

export async function browserCanvasSeedsFromFiles(accountId: string, files: File[]): Promise<NodeSeed[]> {
  assertAccount(accountId);
  if (files.length > MAX_BATCH_FILES) throw new RangeError('canvas_asset_batch_too_many');
  if (files.reduce((total, file) => total + file.size, 0) > MAX_BATCH_BYTES) throw new RangeError('canvas_asset_batch_too_large');
  const prepared = await Promise.all(files.map(async (file) => {
    const [asset, seed] = await Promise.all([
      prepareAsset(accountId, file),
      seedFromFile(file, { store: false }),
    ]);
    return { asset, seed };
  }));
  await storeAssets(prepared.map(({ asset }) => asset));
  return prepared.map(({ asset, seed }) => withAsset(seed, asset));
}

async function hydrateNode(accountId: string, node: WorkspaceNode): Promise<WorkspaceNode> {
  const assetId = typeof node.payload.browserAssetId === 'string' ? node.payload.browserAssetId : '';
  if (!assetId) return node;
  const asset = await readAsset(accountId, assetId).catch(() => undefined);
  if (!asset) {
    return {
      ...node,
      object: node.object ? { ...node.object, status: 'partial' } : node.object,
      payload: { ...node.payload, url: undefined, assetState: 'missing-on-this-device' },
    };
  }
  const viewable = ['image', 'document', 'media', 'model', 'cad'].includes(node.type);
  return {
    ...node,
    payload: {
      ...node.payload,
      ...(viewable ? { url: URL.createObjectURL(new Blob([asset.bytes], { type: asset.mime || 'application/octet-stream' })) } : {}),
      assetState: 'ready',
    },
  };
}

export async function hydrateBrowserCanvasAssets(accountId: string, document: WorkspaceDoc): Promise<WorkspaceDoc> {
  assertAccount(accountId);
  return { ...document, nodes: await Promise.all(document.nodes.map((node) => hydrateNode(accountId, node))) };
}

export const WEB_CANVAS_MAX_FILE_BYTES = MAX_FILE_BYTES;
export const WEB_CANVAS_MAX_BATCH_BYTES = MAX_BATCH_BYTES;
export const WEB_CANVAS_MAX_BATCH_FILES = MAX_BATCH_FILES;
