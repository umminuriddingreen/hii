import { describe, expect, it } from 'vitest';

import { GET, HEAD } from '../../src/routes/install/+server';

describe('public CLI installer route', () => {
  it('serves the reviewed installer as shell source', async () => {
    const response = GET({} as never) as Response;
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/x-shellscript');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(body).toMatch(/^#!\/bin\/sh/);
    expect(body).toContain('umminuriddingreen/hii');
    expect(body).toContain('SHA256SUMS');
  });

  it('supports installer health checks without returning the script', async () => {
    const response = HEAD({} as never) as Response;

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/x-shellscript');
    expect(await response.text()).toBe('');
  });
});
