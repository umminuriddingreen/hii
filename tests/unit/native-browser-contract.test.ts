import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const browserPane = readFileSync(resolve(root, 'src/lib/components/workspace/BrowserPane.svelte'), 'utf8');
const chromiumRuntime = readFileSync(resolve(root, 'lib/server/hii-chromium.ts'), 'utf8');
const browserSession = readFileSync(resolve(root, 'app/api/browser/session/route.ts'), 'utf8');
const browserCommand = readFileSync(resolve(root, 'src-tauri/src/browser.rs'), 'utf8');

describe('native embedded browser contract', () => {
  it('renders command-driven headless Chromium inside HII browser nodes', () => {
    expect(browserPane).toContain("fetch('/api/browser/session'");
    expect(browserPane).toContain("browserEngine: 'chromium-headless'");
    expect(chromiumRuntime).toContain("'--headless=new'");
    expect(chromiumRuntime).toContain("this.call('Page.captureScreenshot'");
    expect(chromiumRuntime).toContain("this.call('Input.dispatchMouseEvent'");
    expect(browserSession).toContain("HII Chromium is local-only");
  });

  it('bounds native navigation to labelled http(s) webviews', () => {
    expect(browserCommand).toContain('BROWSER_LABEL_PREFIX');
    expect(browserCommand).toContain('matches!(parsed.scheme(), "http" | "https")');
  });
});
