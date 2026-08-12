import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('terminal stream lifecycle', () => {
  it('stops asynchronous snapshots before enqueueing after disconnect', () => {
    const route = readFileSync(
      resolve(process.cwd(), 'app/api/terminal/stream/route.ts'),
      'utf8'
    );
    expect(route).toContain('let closed = false');
    expect(route).toMatch(/await getTerminalSnapshot\(\);\s+if \(closed\) return;/);
    expect(route).toMatch(/addEventListener\('abort',[\s\S]*?closed = true;/);
    expect(route).toMatch(/cancel\(\) \{\s+closed = true;/);
  });
});
