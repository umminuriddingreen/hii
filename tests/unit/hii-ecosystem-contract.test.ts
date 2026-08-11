import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const notch = readFileSync(resolve(root, 'src/lib/components/NotchSurface.svelte'), 'utf8');
const browser = readFileSync(resolve(root, 'src/routes/(app)/browser/+page.svelte'), 'utf8');
const create = readFileSync(resolve(root, 'src/routes/(app)/create/+page.svelte'), 'utf8');
const rust = readFileSync(resolve(root, 'src-tauri/src/lib.rs'), 'utf8');
const api = readFileSync(resolve(root, 'app/api/ecosystem/route.ts'), 'utf8');

describe('HII ecosystem surface contract', () => {
  it('names the HII notch surface and the Browser and Create modes', () => {
    expect(notch).toContain('<strong>HII</strong>');
    expect(browser).toContain('<h1>Browser</h1>');
    expect(create).toContain('<h1>Create</h1>');
  });

  it('keeps source capture local and workflow execution explicitly approved', () => {
    expect(browser).toContain("action:'capture'");
    expect(browser).toContain('Captures stay local');
    expect(create).toContain('I reviewed this exact revision');
    expect(api).toContain("body.approved !== true");
  });

  it('uses one native Notch window and routes Browser and Create into the main HII window', () => {
    expect(rust).toContain('/notch');
    expect(rust).toContain('set_notch_expanded');
    expect(rust).toContain('open_hii_mode');
    expect(notch).toContain('openFromNotchHover');
    expect(notch).toContain('on:pointerenter={openFromNotchHover}');
    expect(notch).toContain("openMode('/browser')");
    expect(notch).toContain("openMode('/create')");
  });
});
