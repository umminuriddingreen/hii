import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isAccountCanvasNodeType } from '@/components/spaces/space-surface';
import { renderedBrowserSeed } from '@/lib/workspace/browser-seed';

describe('rendered pasted links', () => {
  it('creates a shared movable browser object for an http link', () => {
    const seed = renderedBrowserSeed('https://www.example.com/reference');
    expect(seed).not.toBeNull();
    expect(seed?.type).toBe('browser');
    expect(seed?.payload).toMatchObject({
      surface: 'native-dev-browser',
      title: 'example.com',
      url: 'https://www.example.com/reference'
    });
    expect(isAccountCanvasNodeType('browser')).toBe(true);
  });

  it('routes native and account clipboard URLs to the rendered browser', () => {
    const root = readFileSync('components/workspace/HiiRoot.tsx', 'utf8');
    const paste = root.slice(root.indexOf('const paste ='), root.indexOf("addEventListener('keydown'"));
    expect(paste).toContain('openDevBrowser(at, value.trim())');
    expect(paste).not.toContain('captureInformation(value.trim())');
  });

  it('keeps the web fallback in an opaque-origin sandbox', () => {
    const browser = readFileSync('components/workspace/NativeDevBrowser.tsx', 'utf8');
    const sandbox = browser.match(/sandbox="([^"]+)"/)?.[1] ?? '';
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
  });
});
