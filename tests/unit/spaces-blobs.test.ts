// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { createSpace } from '../../lib/server/space-store.ts';
import {
  deleteSpaceBlob,
  readSpaceBlob,
  storeSpaceBlob
} from '../../lib/spaces/host/blobs.ts';
import { startSpacesHost, type RunningSpacesHost } from '../../lib/spaces/host/server.ts';

function png(width = 2, height = 3) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type: string, data: Buffer) => {
    const value = Buffer.alloc(12 + data.length);
    value.writeUInt32BE(data.length, 0);
    value.write(type, 4, 'ascii');
    data.copy(value, 8);
    value.writeUInt32BE(crc32(value.subarray(4, 8 + data.length)), 8 + data.length);
    return value;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(height * (1 + width * 4)))), chunk('IEND', Buffer.alloc(0))]);
}

function crc32(input: Buffer) {
  let crc = 0xffff_ffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

let runtimeDir: string;
let appRoot: string;
const hosts: RunningSpacesHost[] = [];

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'hii-spaces-blobs-'));
  appRoot = await mkdtemp(path.join(os.tmpdir(), 'hii-spaces-blob-app-'));
  process.env.HII_RUNTIME_DIR = runtimeDir;
  await mkdir(path.join(appRoot, '_next', 'static'), { recursive: true });
  await writeFile(path.join(appRoot, 'index.html'), '<!doctype html>');
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
  delete process.env.HII_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
  await rm(appRoot, { recursive: true, force: true });
});

async function host() {
  const running = await startSpacesHost({ port: 0, appRoot });
  hosts.push(running);
  return running;
}

describe('canonical Space blob storage', () => {
  it('stores generated opaque references, retrieves after host restart, and deletes internally', async () => {
    await createSpace({ id: 'photo-wall', ownerId: 'user:ummi' });
    const boundary = 'hii-space-upload-boundary';
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="../../phone photo.png"\r\nContent-Type: text/html\r\n\r\n`),
      png(),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const first = await host();
    const guestSession = await fetch(`${first.origins[0]}/api/spaces/photo-wall/guest-session`, {
      method: 'POST', headers: { Origin: first.origins[0] }
    });
    const uploaded = await fetch(`${first.origins[0]}/api/spaces/photo-wall/blobs`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Origin: first.origins[0],
        Cookie: guestSession.headers.get('set-cookie')?.split(';')[0] ?? ''
      },
      body: multipart
    });
    expect(uploaded.status).toBe(201);
    const blob = await uploaded.json();
    expect(blob).toMatchObject({ name: 'phone_photo.png', mime: 'image/png', width: 2, height: 3 });
    expect(blob.path).toMatch(/^space:\/\/photo-wall\/blob_[a-f0-9]{32}$/);
    expect(blob.url).toMatch(/^\/api\/spaces\/photo-wall\/blobs\/blob_[a-f0-9]{32}$/);
    expect(blob.path).not.toContain(runtimeDir);

    await first.stop();
    hosts.splice(hosts.indexOf(first), 1);
    const restarted = await host();
    const response = await fetch(`${restarted.origins[0]}${blob.url}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-disposition')).toMatch(/^inline; filename="blob_/);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png());

    const blobId = blob.path.split('/').at(-1);
    expect(await deleteSpaceBlob('photo-wall', blobId)).toBe(true);
    expect(await readSpaceBlob('photo-wall', blobId)).toBeNull();
    expect((await fetch(`${restarted.origins[0]}${blob.url}`)).status).toBe(404);
  });

  it('enforces Space quota and generates collision-resistant names', async () => {
    const bytes = png();
    await createSpace({
      id: 'bounded',
      ownerId: 'user:ummi',
      policy: { storageQuotaBytes: bytes.length + 1 }
    });
    const first = await storeSpaceBlob({ spaceId: 'bounded', originalName: 'same.png', bytes });
    await expect(storeSpaceBlob({ spaceId: 'bounded', originalName: 'same.png', bytes })).rejects.toThrow(/storage quota/);
    expect(first.path).toMatch(/^space:\/\/bounded\/blob_/);
  });

  it('rejects traversal, executable content, and disabled or frozen upload policy', async () => {
    await createSpace({ id: 'disabled', ownerId: 'user:ummi', policy: { uploadsEnabled: false } });
    await createSpace({ id: 'frozen', ownerId: 'user:ummi', policy: { writesFrozen: true } });
    await expect(storeSpaceBlob({ spaceId: '../escape', originalName: 'x.png', bytes: png() })).rejects.toThrow(/spaceId/);
    await expect(storeSpaceBlob({ spaceId: 'disabled', originalName: 'x.png', bytes: png() })).rejects.toThrow(/disabled/);
    await expect(storeSpaceBlob({ spaceId: 'frozen', originalName: 'x.png', bytes: png() })).rejects.toThrow(/frozen/);
    await expect(storeSpaceBlob({ spaceId: 'frozen', originalName: 'x.svg', bytes: Buffer.from('<svg><script/></svg>') })).rejects.toThrow(/frozen/);
  });

  it('keeps privileged routes and anonymous deletion outside the Space host', async () => {
    await createSpace({ id: 'safe', ownerId: 'user:ummi' });
    const running = await host();
    expect((await fetch(`${running.origins[0]}/api/workspace/assets`)).status).toBe(404);
    expect((await fetch(`${running.origins[0]}/terminal`)).status).toBe(404);
    expect((await fetch(`${running.origins[0]}/api/spaces/safe/blobs/blob_00000000000000000000000000000000`, { method: 'DELETE' })).status).toBe(405);
  });

  it('rejects cross-origin uploads before accepting attacker-controlled bytes', async () => {
    await createSpace({ id: 'same-origin', ownerId: 'user:ummi' });
    const running = await host();
    const boundary = 'cross-origin-boundary';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\n\r\n`),
      png(),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const response = await fetch(`${running.origins[0]}/api/spaces/same-origin/blobs`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Origin: 'https://attacker.example'
      },
      body
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Uploads require the same HII Space origin.' }
    });
  });
});
