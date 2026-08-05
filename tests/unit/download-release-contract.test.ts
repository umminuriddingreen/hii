import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

describe('desktop download contract', () => {
  it('serves versioned desktop artifacts from the bound release bucket', () => {
    const route = read('src/routes/download/[platform]/+server.ts');
    const wrangler = read('wrangler.jsonc');
    const hooks = read('src/hooks.server.ts');
    expect(wrangler).toContain('"binding": "DOWNLOADS"');
    expect(hooks).toContain("'/download/windows'");
    expect(hooks).toContain("'/download/macos'");
    expect(route).toContain('releases/latest-${target}.json');
    expect(route).toContain('content-disposition');
    expect(route).toContain('x-hii-sha256');
  });

  it('offers one direct Windows download without pretending Mac notarization passed', () => {
    const landing = read('src/routes/(app)/landing/+page.svelte');
    expect(landing).toContain('href="/download/windows"');
    expect(landing).toContain('Download for Windows');
    expect(landing).toContain('public download stays closed until Apple notarization passes');
  });
});
