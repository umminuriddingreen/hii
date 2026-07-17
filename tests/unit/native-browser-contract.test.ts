import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const browserPane = readFileSync(resolve(root, 'src/lib/components/workspace/BrowserPane.svelte'), 'utf8');
const browserCommand = readFileSync(resolve(root, 'src-tauri/src/browser.rs'), 'utf8');

describe('native embedded browser contract', () => {
  it('creates and positions a Tauri child webview for browser nodes', () => {
    expect(browserPane).toContain("import('@tauri-apps/api/webview')");
    expect(browserPane).toContain('new Webview(window, browserLabel');
    expect(browserPane).toContain('nativeWebview.setPosition');
    expect(browserPane).toContain('nativeWebview.setSize');
  });

  it('bounds native navigation to labelled http(s) webviews', () => {
    expect(browserCommand).toContain('BROWSER_LABEL_PREFIX');
    expect(browserCommand).toContain('matches!(parsed.scheme(), "http" | "https")');
  });
});
