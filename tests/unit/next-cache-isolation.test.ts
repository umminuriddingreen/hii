import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Next.js cache isolation', () => {
  it('keeps web and desktop development chunks outside the production build directory', () => {
    const config = readFileSync('next.config.mjs', 'utf8');
    const webDev = readFileSync('scripts/hii-dev.mjs', 'utf8');
    const ignored = readFileSync('.gitignore', 'utf8');
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>;

    expect(config).toContain("distDir: process.env.HII_NEXT_DIST_DIR || '.next'");
    expect(webDev).toContain("HII_NEXT_DIST_DIR: process.env.HII_NEXT_DIST_DIR || '.next-web-dev'");
    expect(scripts['dev:desktop']).toContain('HII_NEXT_DIST_DIR=.next-desktop-dev');
    expect(scripts['dev:desktop:waymark']).toContain('HII_NEXT_DIST_DIR=.next-desktop-dev');
    expect(scripts.build).not.toContain('HII_NEXT_DIST_DIR');
    expect(ignored).toContain('/.next-web-dev/');
    expect(ignored).toContain('/.next-desktop-dev/');
  });
});
