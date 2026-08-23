import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Space } from '../../lib/spaces/types';
import { defaultSpacePolicy } from '../../lib/spaces/types';
import {
  createSpaceFromName,
  generateOfflineSpaceQrDataUrl,
  spaceQrPayload
} from '../../lib/spaces/access-link';

const qrSource = readFileSync(
  path.join(import.meta.dirname, '../../components/spaces/SpaceQr.tsx'),
  'utf8'
);
const createSource = readFileSync(
  path.join(import.meta.dirname, '../../components/spaces/CreateSpace.tsx'),
  'utf8'
);

function space(id = '14th-street'): Space {
  return {
    schemaVersion: 1,
    id,
    name: '14th Street',
    ownerId: 'user:ummi',
    policy: defaultSpacePolicy(),
    hosting: 'local-only',
    publication: { state: 'unpublished', updatedAt: '2026-08-20T00:00:00.000Z' },
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    revision: 1
  };
}

describe('Space create and QR share contracts', () => {
  it('creates through a passed canonical-store callback without importing the server store', async () => {
    const onCreate = vi.fn(async () => space());
    const created = await createSpaceFromName('  14th Street  ', 'user:ummi', onCreate);
    expect(onCreate).toHaveBeenCalledWith({
      id: '14th-street',
      ownerId: 'user:ummi',
      name: '14th Street'
    });
    expect(created.id).toBe('14th-street');
    expect(createSource).not.toContain("lib/server/space-store");
    expect(createSource).toContain('onCreate');
  });

  it('passes the exact access URL to the offline QR renderer', () => {
    const exactUrl = 'http://192.168.1.12:4312/s/14th-street';
    expect(spaceQrPayload(exactUrl)).toBe(exactUrl);
    expect(qrSource).toContain('const payload = spaceQrPayload(url)');
    expect(qrSource).toContain('data-qr-payload={payload}');
    expect(qrSource).toContain('{renderQr(payload)}');
  });

  it('generates a local SVG image data URL without executable markup', async () => {
    const first = await generateOfflineSpaceQrDataUrl('http://10.0.0.4:4312/s/s1');
    const second = await generateOfflineSpaceQrDataUrl('http://10.0.0.4:4312/s/s2');
    expect(first).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(first).not.toBe(second);
    const svg = decodeURIComponent(first.slice(first.indexOf(',') + 1));
    expect(svg).toContain('<svg');
    expect(svg).toContain('<path');
    expect(svg).not.toMatch(/<script|onload=|javascript:/i);
  });

  it('renders generated SVG through an image rather than injecting markup', () => {
    expect(qrSource).toContain('generateOfflineSpaceQrDataUrl(payload)');
    expect(qrSource).toContain('src={generatedQr.dataUrl}');
    expect(qrSource).not.toContain('dangerouslySetInnerHTML');
    expect(qrSource).not.toContain('fetch(');
  });

  it('keeps an accessible exact-link fallback if local encoding fails', () => {
    expect(qrSource).toContain('QR code unavailable');
    expect(qrSource).toContain('<a href={url}>{url}</a>');
    expect(qrSource).toContain('Copy link');
    expect(qrSource).toContain('Open Space');
    expect(qrSource).toContain('aria-live="polite"');
  });
});
