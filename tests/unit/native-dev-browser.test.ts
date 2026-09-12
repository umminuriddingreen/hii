import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserNavigationTarget, browserTargetKind, normalizedBrowserUrl } from '@/lib/workspace/browser-target';

describe('HII interactive browser targets', () => {
  it('defaults bare localhost services to http', () => {
    expect(normalizedBrowserUrl('localhost:3000')).toBe('http://localhost:3000/');
    expect(normalizedBrowserUrl('127.0.0.1:5173/app')).toBe('http://127.0.0.1:5173/app');
  });

  it('defaults public hosts to https and rejects non-web protocols', () => {
    expect(normalizedBrowserUrl('example.com/docs')).toBe('https://example.com/docs');
    expect(normalizedBrowserUrl('file:///tmp/private')).toBeNull();
  });

  it('distinguishes local services from public websites', () => {
    expect(browserTargetKind('http://127.0.0.1:3000')).toBe('local-service');
    expect(browserTargetKind('http://[::1]:3000')).toBe('local-service');
    expect(browserTargetKind('https://humaninformationinterface.com')).toBe('website');
    expect(browserTargetKind('not a url')).toBe('invalid');
  });

  it('turns non-URL input into a search inside the native webview', () => {
    expect(browserNavigationTarget('local first human interface')).toBe(
      'https://www.google.com/search?q=local%20first%20human%20interface'
    );
    expect(browserNavigationTarget('spatial computing interfaces')).toBe(
      'https://www.google.com/search?q=spatial%20computing%20interfaces'
    );
    expect(browserNavigationTarget('architecture')).toBe('https://www.google.com/search?q=architecture');
    expect(browserNavigationTarget('site:archdaily.com museum')).toBe('https://www.google.com/search?q=site%3Aarchdaily.com%20museum');
    expect(browserNavigationTarget('archdaily.com')).toBe('https://archdaily.com/');
    expect(browserNavigationTarget('file:///tmp/private')).toBeNull();
  });

  it('projects search sources and live pages as independent canvas objects', () => {
    const root = readFileSync(resolve(process.cwd(), 'components/workspace/HiiRoot.tsx'), 'utf8');
    const browser = readFileSync(resolve(process.cwd(), 'components/workspace/NativeDevBrowser.tsx'), 'utf8');
    const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8');
    expect(root).toContain("findInformation(query, { web: true, limit: 8 })");
    expect(root).toContain("type: 'link'");
    expect(root).toContain('onOpenBrowser={(url) => openDevBrowser');
    expect(browser).toContain('onOpenObject(url)');
    expect(browser).toContain("action('back')");
    expect(browser).toContain("action('forward')");
    expect(browser).toContain("action('reload')");
    expect(browser).toContain('className="hii-browser-address"');
    expect(browser).toContain('aria-label="Search or open another page"');
    expect(browser).toContain('className="hii-browser-omnibox-options"');
    expect(browser).toContain('activeSearchQuery');
    expect(browser).toContain('className="hii-browser-results"');
    expect(css).toContain('.hii-node[data-node-type="browser"] { overflow: visible; contain: none; }');
  });
});
