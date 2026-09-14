// SPDX-License-Identifier: LicenseRef-BSL-1.1

import type { ChatDevice, LocalChatDevice } from './chat-crypto';
import {
  decryptBrowserSnapshot, encryptBrowserSnapshot,
  type BrowserSnapshot, type BrowserSnapshotEnvelope,
} from './browser-snapshot-crypto';

const BASE = '/api/browser-snapshots';

async function responseJson<T>(response: Response): Promise<T> {
  const value = await response.json();
  if (!response.ok) throw new Error(value?.error || `browser_snapshot_http_${response.status}`);
  return value as T;
}

export async function uploadBrowserSnapshot(snapshot: BrowserSnapshot, local: LocalChatDevice, csrfToken: string) {
  const deviceResponse = await responseJson<{ devices: Array<Pick<ChatDevice, 'id' | 'ecdhPublicJwk' | 'signingPublicJwk'>> }>(
    await fetch(`${BASE}/devices`, { credentials: 'include', cache: 'no-store' }),
  );
  const devices: ChatDevice[] = deviceResponse.devices.map((device) => ({ ...device, accountId: '', active: true }));
  const envelope = await encryptBrowserSnapshot(snapshot, local, devices);
  await responseJson(await fetch(BASE, {
    method: 'POST', credentials: 'include', cache: 'no-store',
    headers: { 'content-type': 'application/json', 'x-hii-csrf': csrfToken },
    body: JSON.stringify(envelope),
  }));
  return envelope.id;
}

export type SnapshotChange = {
  seq: number;
  id: string;
  sourceId: string;
  senderDeviceId: string;
  bytesUsed: number;
  createdAt: number;
  deletedAt: number | null;
};

export async function pullBrowserSnapshots(after: number, local: LocalChatDevice) {
  const manifest = await responseJson<{ snapshots: SnapshotChange[]; next: number }>(
    await fetch(`${BASE}?after=${encodeURIComponent(after)}`, { credentials: 'include', cache: 'no-store' }),
  );
  const changes: Array<{ change: SnapshotChange; snapshot?: BrowserSnapshot }> = [];
  for (const change of manifest.snapshots) {
    if (change.deletedAt !== null) {
      changes.push({ change });
      continue;
    }
    const envelope = await responseJson<BrowserSnapshotEnvelope>(
      await fetch(`${BASE}/${encodeURIComponent(change.id)}`, { credentials: 'include', cache: 'no-store' }),
    );
    changes.push({ change, snapshot: await decryptBrowserSnapshot(envelope, local) });
  }
  return { changes, next: manifest.next };
}

export async function deleteBrowserSnapshot(id: string, csrfToken: string) {
  await responseJson(await fetch(`${BASE}/${encodeURIComponent(id)}`, {
    method: 'DELETE', credentials: 'include', cache: 'no-store',
    headers: { 'x-hii-csrf': csrfToken },
  }));
}
