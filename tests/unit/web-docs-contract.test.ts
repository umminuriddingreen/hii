import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hiiDocsCatalog, readHiiDoc } from '../../lib/server/hii-docs';

const root = process.cwd();
const shell = readFileSync(resolve(root, 'src/lib/components/docs/HiiDocsShell.svelte'), 'utf8');
const layout = readFileSync(resolve(root, 'src/routes/(app)/+layout.svelte'), 'utf8');
const legacySdkRoute = readFileSync(resolve(root, 'src/routes/(app)/docs/hii-sdk-contracts/+page.server.ts'), 'utf8');

describe('HII web documentation', () => {
  it('compiles every canonical repository document into a stable route', () => {
    expect(hiiDocsCatalog).toHaveLength(16);
    expect(new Set(hiiDocsCatalog.map((doc) => doc.slug)).size).toBe(hiiDocsCatalog.length);
    for (const entry of hiiDocsCatalog) {
      expect(readHiiDoc(entry.slug)?.markdown.length).toBeGreaterThan(100);
    }
  });

  it('keeps provenance and document status visible', () => {
    expect(shell).toContain('Source');
    expect(shell).toContain('Status');
    expect(shell).toContain('Compiled');
    expect(shell).toContain('doc.source');
    expect(shell).toContain('data-status');
  });

  it('renders docs as a first-party flush HII surface', () => {
    expect(layout).toContain("startsWith('/docs')");
    expect(layout).toContain("title: 'Documentation'");
    expect(layout).toContain('flush: true');
    expect(legacySdkRoute).toContain("redirect(308, '/docs/sdk-contracts')");
  });
});
