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
    expect(homepage).toContain('A workspace for<br />everything you’re<br /><em>making.</em>');
    expect(homepage).toContain('Open HII');
    expect(homepage).toContain('Visual workspace · Mac + Windows');
    expect(homepage).toContain('Get the desktop app');
    expect(homepage).toContain('/marketing/hii-workspace-live.png');
    expect(homepage).toContain('/marketing/hii-first-win-demo.mp4');
    expect(homepage).toContain('actual interface');
  });

  it('presents HII as a broad visual workspace with concrete, truthful uses', () => {
    expect(homepage).toContain('Like a canvas.<br /><em>But it can help.</em>');
    expect(homepage).toContain('Find a direction');
    expect(homepage).toContain('Make an artifact');
    expect(homepage).toContain('Understand a project');
    expect(homepage).toContain('The browser demo uses sample data and cannot access your computer');
    expect(homepage).toContain('href="/learn"');
  });

  it('offers the verified Windows path without overstating Mac release trust', () => {
    expect(homepage).toContain('Windows 10 / 11 · x64');
    expect(homepage).toContain('Download for Windows');
    expect(homepage).toContain('No administrator account required');
    expect(homepage).toContain('public download stays closed until Apple notarization passes');
    expect(homepage).toContain('We do not ask you to disable');
  });

  it('links to a plain-language privacy boundary before public recruitment', () => {
    expect(homepage).toContain('href="/privacy"');
    expect(homepage).toContain('Architecture example');
    expect(privacy).toContain('They do not run an agent, inspect your Mac, read your files');
    expect(privacy).toContain('Choosing a local Ollama model keeps model inference on your Mac');
    expect(privacy).toContain('Cloudflare serves this site');
    expect(privacy).toContain('HII does not sell applicant information');
  });

  it('offers architects and computational designers a truthful segment-specific first win', () => {
    expect(serverHooks).toContain("'/architecture'");
    expect(architecture).toContain('https://humaninformationinterface.com/architecture');
    expect(architecture).toContain('HII for architecture + computational design');
    expect(architecture).toContain('architecture / example workspace');
    expect(architecture).toContain('not a separate architecture product');
    expect(architecture).toContain('Trace a site decision');
    expect(architecture).toContain('Prepare a design review');
    expect(architecture).toContain('Debug a computational workflow');
    expect(architecture).toContain('A model is not<br />a project boundary.');
    expect(architecture).toContain('/marketing/hii-architecture-hero.png');
    expect(architecture).toContain('/marketing/hii-architecture-first-win-demo.mp4');
    expect(architecture).toContain('The demonstration uses sample data and cannot inspect your Mac');
    expect(architecture).toContain('Apply for founder activation · $500');
    expect(architecture).toContain('href="/privacy"');
  });
});
