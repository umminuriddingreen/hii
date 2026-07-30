import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const workspace = readFileSync(resolve(root, 'src/lib/components/workspace/WorkspacePage.svelte'), 'utf8');
const chat = readFileSync(resolve(root, 'src/lib/components/workspace/ChatPane.svelte'), 'utf8');
const spatialRun = readFileSync(resolve(root, 'src/lib/components/workspace/SpatialRunPane.svelte'), 'utf8');
const workspaceRuns = readFileSync(resolve(root, 'lib/server/hii-workspace-runs.ts'), 'utf8');
const workspaceRunRoute = readFileSync(resolve(root, 'app/api/workspace/runs/route.ts'), 'utf8');
const explorer = readFileSync(resolve(root, 'src/lib/components/workspace/ExplorerPane.svelte'), 'utf8');
const terminal = readFileSync(resolve(root, 'src/lib/components/TerminalPane.svelte'), 'utf8');
const desktop = readFileSync(resolve(root, 'src-tauri/src/lib.rs'), 'utf8');
const cargo = readFileSync(resolve(root, 'src-tauri/Cargo.toml'), 'utf8');
const packageJson = readFileSync(resolve(root, 'package.json'), 'utf8');
const desktopBuild = readFileSync(resolve(root, 'scripts/hii-tauri-build.mjs'), 'utf8');
const desktopInstall = readFileSync(resolve(root, 'scripts/hii-tauri-install.mjs'), 'utf8');
const desktopRelease = readFileSync(resolve(root, 'scripts/hii-macos-release.mjs'), 'utf8');
const cursorBar = readFileSync(resolve(root, 'src/routes/palette/+page.svelte'), 'utf8');

describe('agentic workspace interaction contract', () => {
  it('summons direct workspace intent from Option+Space', () => {
    expect(workspace).toContain("event.altKey&&event.code==='Space'");
    expect(workspace).toContain("listen('hii://summon'");
    expect(workspace).toContain("window.addEventListener('hii:summon'");
    expect(workspace).toContain('approved context');
    expect(workspace).toContain("seedFor('intent'");
    expect(workspace).toContain("seedFor('run'");
    expect(spatialRun).toContain('Approve bounded run');
    expect(spatialRun).toContain("action: 'approve'");
  });

  it('hands selected context to the real AII workspace runner and branches from its receipt', () => {
    expect(workspace).toContain('selectedContextNodes');
    expect(spatialRun).toContain('Approved canvas context');
    expect(spatialRun).toContain('/api/workspace/runs');
    expect(spatialRun).toContain('setTimeout(resolve, 1000)');
    expect(workspaceRuns).toContain("kind: 'workspace.run'");
    expect(workspaceRuns).toContain('Explicit approval is required');
    expect(workspaceRunRoute).toContain('queueApprovedWorkspaceRun');
    expect(spatialRun).toContain('onFollowUp(text)');
    expect(workspace).toContain('parentId:intentNode.id');
    expect(chat).toContain('run.visibleOutput');
  });

  it('uses the installed HII model default and preserves truthful terminal failures', () => {
    expect(workspace).toContain("model:'qwen3.6:35b-mlx'");
    expect(workspaceRuns).toContain("defaultWorkspaceRunModel = 'qwen3.6:35b-mlx'");
    expect(spatialRun).toContain("let error = String(node.payload.error || '')");
    expect(spatialRun).toContain("error: failureError");
    expect(spatialRun).toContain('Branch a revised intent from this run…');
  });

  it('materializes proof lineage and keeps capability promotion operator-reviewed', () => {
    expect(workspace).toContain("kind:'artifact'");
    expect(workspace).toContain("kind:'receipt'");
    expect(workspace).toContain("kind:'capability'");
    expect(workspace).toContain('workspaceConnections');
    expect(spatialRun).toContain('Save verified run as capability draft');
    expect(workspaceRuns).toContain('createWorkspaceRunCapabilityDraft');
    expect(workspaceRuns).toContain("'--repeatable'");
    expect(workspaceRuns).not.toContain('skill register');
  });

  it('opens the combined browser and terminal explorer on workspace double-click', () => {
    expect(workspace).toContain('on:dblclick={openExplorer}');
    expect(workspace).toContain("seedFor('explorer')");
    expect(explorer).toContain('<BrowserPane');
    expect(explorer).toContain('<TerminalPane');
  });

  it('supports natural trackpad pan and cursor-anchored zoom', () => {
    expect(workspace).toContain('on:wheel={trackpad}');
    expect(workspace).toContain('canNestedSurfaceScroll');
    expect(workspace).toContain('panWorkspaceViewport');
    expect(workspace).toContain('zoomWorkspaceViewportAt');
  });

  it('keeps large spatial workspaces recoverable and navigable', () => {
    expect(workspace).toContain('countWorkspaceNodesInViewport');
    expect(workspace).toContain('Your workspace is outside this view.');
    expect(workspace).toContain('Show my work');
    expect(workspace).toContain('Workspace map');
    expect(workspace).toContain('Key places');
    expect(workspace).toContain('openFrame(frame)');
  });

  it('bridges an explicit browser request into its paired terminal', () => {
    expect(explorer).toContain('curl -I -L --max-time 20 --');
    expect(explorer).toContain("new CustomEvent('hii:terminal-command'");
    expect(terminal).toContain("window.addEventListener('hii:terminal-command'");
  });

  it('registers a portable cursor-bar shortcut in the Tauri shell', () => {
    expect(cargo).toContain('tauri-plugin-global-shortcut');
    expect(desktop).toContain('Modifiers::SUPER | Modifiers::SHIFT');
    expect(desktop).toContain('Modifiers::CONTROL | Modifiers::SHIFT');
    expect(desktop).toContain('"super+shift+space"');
    expect(desktop).toContain('"ctrl+shift+space"');
    expect(desktop).toContain('show_cursor_bar(app)');
    expect(desktop).toContain('app.cursor_position()');
  });

  it('keeps cursor intent inside the shared HII runner', () => {
    expect(desktop).toContain('fn run_cursor_intent');
    expect(desktop).toContain('.arg("run")');
    expect(desktop).toContain('.join("cursor-bar")');
    expect(cursorBar).toContain("invoke<string>('run_cursor_intent'");
    expect(cursorBar).toContain("invoke('hide_cursor_bar')");
    expect(cursorBar).toContain('What do you want to happen?');
  });

  it('starts the baked HII runtime in production instead of attaching to stale UI', () => {
    expect(desktop).toContain('#[cfg(dev)]');
    expect(desktop).toContain('#[cfg(not(dev))]');
    expect(desktop).toMatch(
      /#\[cfg\(not\(dev\)\)\][\s\S]*available_port\(\)\?[\s\S]*spawn_hii_server\(app, port\)/
    );
  });

  it('seals and strictly verifies the packaged macOS app', () => {
    expect(packageJson).toContain('node scripts/hii-tauri-build.mjs');
    expect(desktopBuild).toContain("'codesign'");
    expect(desktopBuild).toContain("'--strict'");
    expect(packageJson).toContain('install:tauri');
    expect(desktopInstall).toContain("'/Applications/HII.app'");
    expect(desktopInstall).toContain("'.Trash'");
    expect(desktopInstall).toContain("'--strict'");
  });

  it('keeps public Mac releases behind Developer ID and notarization proof', () => {
    expect(packageJson).toContain('release:mac');
    expect(desktopRelease).toContain('HII_SIGNING_IDENTITY');
    expect(desktopRelease).toContain('HII_NOTARY_PROFILE');
    expect(desktopRelease).toContain("'notarytool'");
    expect(desktopRelease).toContain("'stapler'");
    expect(desktopRelease).toContain("'spctl'");
    expect(desktopRelease).toContain('sha256');
    expect(desktopRelease).toContain("'latest.json'");
  });
});
