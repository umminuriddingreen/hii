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
    expect(homepage).toContain('Your work,<br /><em>alive.</em>');
    expect(homepage).toContain('Create your account');
    expect(homepage).toContain('Mac installer · preparing');
    expect(homepage).toContain('/marketing/hii-workspace-live.png');
    expect(homepage).toContain('/marketing/hii-command-palette-live.png');
    expect(homepage).toContain('Actual HII interface · staged founder-beta project content · captured locally');
  });
});
