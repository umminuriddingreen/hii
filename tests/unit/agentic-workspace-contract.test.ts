import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const workspace = readFileSync(resolve(root, 'src/routes/+page.svelte'), 'utf8');
const chat = readFileSync(resolve(root, 'src/lib/components/workspace/ChatPane.svelte'), 'utf8');
const spatialRun = readFileSync(resolve(root, 'src/lib/components/workspace/SpatialRunPane.svelte'), 'utf8');
const explorer = readFileSync(resolve(root, 'src/lib/components/workspace/ExplorerPane.svelte'), 'utf8');
const terminal = readFileSync(resolve(root, 'src/lib/components/TerminalPane.svelte'), 'utf8');
const desktop = readFileSync(resolve(root, 'src-tauri/src/lib.rs'), 'utf8');
const cargo = readFileSync(resolve(root, 'src-tauri/Cargo.toml'), 'utf8');
const packageJson = readFileSync(resolve(root, 'package.json'), 'utf8');
const desktopBuild = readFileSync(resolve(root, 'scripts/hii-tauri-build.mjs'), 'utf8');

describe('agentic workspace interaction contract', () => {
  it('summons direct workspace intent from Option+Space', () => {
    expect(workspace).toContain("event.altKey&&event.code==='Space'");
    expect(workspace).toContain("listen('hii://summon'");
    expect(workspace).toContain("window.addEventListener('hii:summon'");
    expect(workspace).toContain('direct workspace intent');
    expect(workspace).toContain("seedFor('intent'");
    expect(workspace).toContain("seedFor('run'");
    expect(spatialRun).toContain('node.payload.autoStart');
  });

  it('streams managed output and branches follow-up intent on the canvas', () => {
    expect(spatialRun).toContain('run.visibleOutput');
    expect(spatialRun).toContain('setTimeout(resolve, 850)');
    expect(spatialRun).toContain("action: 'codex.stop'");
    expect(spatialRun).toContain('onFollowUp(text)');
    expect(workspace).toContain('parentId:intentNode.id');
    expect(chat).toContain('run.visibleOutput');
  });

  it('opens the combined browser and terminal explorer on workspace double-click', () => {
    expect(workspace).toContain('on:dblclick={openExplorer}');
    expect(workspace).toContain("seedFor('explorer')");
    expect(explorer).toContain('<BrowserPane');
    expect(explorer).toContain('<TerminalPane');
  });

  it('bridges an explicit browser request into its paired terminal', () => {
    expect(explorer).toContain('curl -I -L --max-time 20 --');
    expect(explorer).toContain("new CustomEvent('hii:terminal-command'");
    expect(terminal).toContain("window.addEventListener('hii:terminal-command'");
  });

  it('registers a non-fatal native global shortcut in the Tauri shell', () => {
    expect(cargo).toContain('tauri-plugin-global-shortcut');
    expect(desktop).toContain('shortcut.matches(Modifiers::ALT, Code::Space)');
    expect(desktop).toContain('app.global_shortcut().register("alt+space")');
    expect(desktop).toContain("new CustomEvent('hii:summon'");
    expect(desktop).toMatch(/window\.emit\(\s*"hii:\/\/summon"/);
  });

  it('seals and strictly verifies the packaged macOS app', () => {
    expect(packageJson).toContain('node scripts/hii-tauri-build.mjs');
    expect(desktopBuild).toContain("'codesign'");
    expect(desktopBuild).toContain("'--strict'");
  });
});
