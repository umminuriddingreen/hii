import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DesktopRelease } from '@/components/public/DesktopRelease';

const release = {
  version: '0.4.0', filename: 'HII.dmg', bytes: 1024,
  sha256: 'a'.repeat(64), createdAt: '2026-09-08T00:00:00Z',
};
const response = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
let root: Root | undefined;
let container: HTMLDivElement;
async function show() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<DesktopRelease platform="macos" label="Download for Mac" />); });
}
async function cleanup() {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
}

afterEach(async () => { await cleanup(); vi.unstubAllGlobals(); });

describe('desktop release availability', () => {
  it('separates sign-in from an unpublished release', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(401)));
    await show();
    expect(container.textContent).toContain('Sign in');
    expect(container.textContent).not.toContain('No build published');
    await cleanup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(404)));
    await show();
    expect(container.textContent).toContain('No build published');
  });

  it('lets a failed service check recover without inventing an absent release', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(503)).mockResolvedValueOnce(response(200, release));
    vi.stubGlobal('fetch', fetch);
    await show();
    expect(container.textContent).toContain('service could not check');
    expect(container.textContent).not.toContain('No build published');
    await act(async () => { container.querySelector('button')!.click(); });
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/download/macos');
    expect(container.textContent).toContain(release.sha256);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('describes connectivity failures and allows retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await show();
    expect(container.textContent).toContain('Check your connection');
    expect(container.querySelector('button')?.textContent).toBe('Try again');
  });

  it.each([
    { ...release, createdAt: 'invalid-date' },
    { ...release, bytes: -1 },
    { ...release, sha256: 'not-a-checksum' },
    { ...release, filename: '../HII.dmg' },
    null,
  ])('rejects invalid metadata without rendering an unsafe download or crashing', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, body)));
    await show();
    expect(container.textContent).toContain('information is incomplete or invalid');
    expect(container.querySelector('a')).toBeNull();
  });

  it('handles non-JSON metadata as a publication error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>not json</html>')));
    await show();
    expect(container.textContent).toContain('information is incomplete or invalid');
  });
});
