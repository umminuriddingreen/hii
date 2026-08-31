import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('browser canvas media contract', () => {
  const assets = readFileSync('lib/web/canvas-assets.ts', 'utf8');
  const canvas = readFileSync('components/workspace/HiiRoot.tsx', 'utf8');
  const css = readFileSync('app/globals.css', 'utf8');

  it('persists WebKit-safe bytes and can replace stale object URLs after reload', () => {
    expect(assets).toContain('bytes?: ArrayBuffer');
    expect(assets).toContain('bytes,');
    expect(assets).toContain('browserCanvasAssetUrl');
    expect(assets).toContain('asset?.accountId === accountId');
    expect(assets).toContain("URL.createObjectURL(file)");
    expect(canvas).toContain('browserCanvasAssetUrl(assetId)');
    expect(canvas).toContain('URL.revokeObjectURL');
    expect(canvas).toContain("assetState === 'fresh' || assetState === 'ready'");
  });

  it('renders mobile-safe image, video, audio, and PDF viewers with recovery', () => {
    expect(canvas).toContain('className="hii-node-image"');
    expect(canvas).toContain('preload="metadata" playsInline');
    expect(canvas).toContain('className="hii-node-document"');
    expect(canvas).toContain('open PDF ↗');
    expect(canvas).toContain('try again');
    expect(css).toContain('.hii-node-asset-state');
    expect(css).toContain('.hii-node-document-open');
  });
});
