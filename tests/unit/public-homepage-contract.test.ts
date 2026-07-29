import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const hooks = readFileSync(path.join(root, 'src/hooks.ts'), 'utf8');
const vite = readFileSync(path.join(root, 'vite.config.ts'), 'utf8');
const homepage = readFileSync(path.join(root, 'src/routes/(app)/landing/+page.svelte'), 'utf8');

describe('public HII homepage', () => {
  it('serves the homepage at the canonical domain without replacing the local workspace root', () => {
    expect(hooks).toContain("'humaninformationinterface.com'");
    expect(hooks).toContain("'www.humaninformationinterface.com'");
    expect(hooks).toContain("return '/landing'");
    expect(vite).toContain("allowedHosts: ['humaninformationinterface.com', 'www.humaninformationinterface.com']");
  });

  it('states the product truth and carries canonical metadata', () => {
    expect(homepage).toContain('https://humaninformationinterface.com/');
    expect(homepage).toContain('Your information.<br />Your agents.<br /><em>One workspace.</em>');
    expect(homepage).toContain('Get the Mac beta');
    expect(homepage).toContain('Signed Mac installer · preparing');
    expect(homepage).toContain('/marketing/hii-workspace-live.png');
    expect(homepage).toContain('/marketing/hii-command-palette-live.png');
    expect(homepage).toContain('Actual interface · local project · no concept render');
  });

  it('presents one truthful free product and one concrete paid activation', () => {
    expect(homepage).toContain('Local beta');
    expect(homepage).toContain('Founder activation');
    expect(homepage).toContain('$500 <small>one time</small>');
    expect(homepage).toContain('Developer ID signing and Apple notarization pass');
    expect(homepage).toContain('We will never ask you to bypass Gatekeeper');
  });
});
