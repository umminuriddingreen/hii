import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const hooks = readFileSync(path.join(root, 'src/hooks.ts'), 'utf8');
const vite = readFileSync(path.join(root, 'vite.config.ts'), 'utf8');
const homepage = readFileSync(path.join(root, 'src/routes/(app)/landing/+page.svelte'), 'utf8');
const privacy = readFileSync(path.join(root, 'src/routes/privacy/+page.svelte'), 'utf8');
const architecture = readFileSync(path.join(root, 'src/routes/architecture/+page.svelte'), 'utf8');
const serverHooks = readFileSync(path.join(root, 'src/hooks.server.ts'), 'utf8');

describe('public HII homepage', () => {
  it('serves the homepage at the canonical domain without replacing the local workspace root', () => {
    expect(hooks).toContain("'humaninformationinterface.com'");
    expect(hooks).toContain("'www.humaninformationinterface.com'");
    expect(hooks).toContain("return '/landing'");
    expect(vite).toContain("allowedHosts: ['humaninformationinterface.com', 'www.humaninformationinterface.com']");
  });

  it('states the product truth and carries canonical metadata', () => {
    expect(homepage).toContain('https://humaninformationinterface.com/');
    expect(homepage).toContain('Turn what is<br />on your Mac into<br /><em>finished work.</em>');
    expect(homepage).toContain('Try one win in your browser');
    expect(homepage).toContain('Join the Mac beta');
    expect(homepage).toContain('Signed Mac installer · preparing');
    expect(homepage).toContain('/marketing/hii-workspace-live.png');
    expect(homepage).toContain('/marketing/hii-command-palette-live.png');
    expect(homepage).toContain('/marketing/hii-first-win-demo.mp4');
    expect(homepage).toContain('Actual interface · silent-first demo · captions included');
  });

  it('targets people who make and learn with concrete, truthful first wins', () => {
    expect(homepage).toContain('For people making and learning on a Mac');
    expect(homepage).toContain('For makers · creators · designers · researchers · independent operators');
    expect(homepage).toContain('Learn a hard tool');
    expect(homepage).toContain('Finish something');
    expect(homepage).toContain('Improve my work');
    expect(homepage).toContain('No agent runs on the demo page');
    expect(homepage).toContain('href="/learn"');
  });

  it('presents one truthful free product and one concrete paid activation', () => {
    expect(homepage).toContain('Local beta');
    expect(homepage).toContain('Founder activation');
    expect(homepage).toContain('$500 <small>one time</small>');
    expect(homepage).toContain('Developer ID signing and Apple notarization pass');
    expect(homepage).toContain('We will never ask you to bypass Gatekeeper');
  });

  it('links to a plain-language privacy boundary before public recruitment', () => {
    expect(homepage).toContain('href="/privacy"');
    expect(homepage).toContain('href="/architecture"');
    expect(privacy).toContain('They do not run an agent, inspect your Mac, read your files');
    expect(privacy).toContain('Choosing a local Ollama model keeps model inference on your Mac');
    expect(privacy).toContain('Cloudflare serves this site');
    expect(privacy).toContain('HII does not sell applicant information');
  });

  it('offers architects and computational designers a truthful segment-specific first win', () => {
    expect(serverHooks).toContain("'/architecture'");
    expect(architecture).toContain('https://humaninformationinterface.com/architecture');
    expect(architecture).toContain('HII for architecture + computational design');
    expect(architecture).toContain('Trace a site decision');
    expect(architecture).toContain('Prepare a design review');
    expect(architecture).toContain('Debug a computational workflow');
    expect(architecture).toContain('A model is not<br />a project boundary.');
    expect(architecture).toContain('/marketing/hii-first-win-demo.mp4');
    expect(architecture).toContain('The demonstration uses sample data and cannot inspect your Mac');
    expect(architecture).toContain('Apply for founder activation · $500');
    expect(architecture).toContain('href="/privacy"');
  });
});
