import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { GET, HEAD } from '../../src/routes/install/+server';
import { GET as GET_RELEASE } from '../../src/routes/cli/releases/latest/[asset]/+server';

describe('public CLI installer route', () => {
  it('is admitted through the fail-closed Cloudflare launch boundary', () => {
    const hooks = readFileSync(path.join(process.cwd(), 'src/hooks.server.ts'), 'utf8');

    expect(hooks).toContain("'/install'");
  });

  it('serves the reviewed installer as shell source', async () => {
    const response = GET({} as never) as Response;
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/x-shellscript');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(body).toMatch(/^#!\/bin\/sh/);
    expect(body).toContain('humaninformationinterface.com/cli/releases/latest');
    expect(body).toContain('SHA256SUMS');
  });

  it('supports installer health checks without returning the script', async () => {
    const response = HEAD({} as never) as Response;

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/x-shellscript');
    expect(await response.text()).toBe('');
  });

  it('serves only allowlisted assets from the current R2 release', async () => {
    const get = async (key: string) => {
      if (key === 'cli/releases/latest.json') {
        return { json: async () => ({ tag: 'cli-v0.1.0' }) };
      }
      if (key === 'cli/releases/cli-v0.1.0/SHA256SUMS') {
        return {
          body: 'verified checksums',
          size: 18,
          httpEtag: 'proof',
          json: async () => ({})
        };
      }
      return null;
    };
    const response = (await GET_RELEASE({
      params: { asset: 'SHA256SUMS' },
      platform: { env: { DOWNLOADS: { get } } }
    } as never)) as Response;

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('verified checksums');
    await expect(
      GET_RELEASE({
        params: { asset: '../private' },
        platform: { env: { DOWNLOADS: { get } } }
      } as never)
    ).rejects.toMatchObject({ status: 404 });
  });
});
