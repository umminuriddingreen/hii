import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import robots from '../../app/robots';
import sitemap from '../../app/sitemap';
import { PUBLIC_ROUTES, SITE_ORIGIN } from '../../lib/site';

const root = path.resolve(import.meta.dirname, '../..');
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

/**
 * The public web surface makes promises that are only visible off-machine: to
 * crawlers, to social scrapers, and to a person who hits a broken route. None
 * of them show up in a screenshot, so they are asserted here.
 */
describe('public web surface', () => {
  describe('crawler contract', () => {
    it('advertises the sitemap on the canonical origin', () => {
      const result = robots();
      expect(result.sitemap).toBe(`${SITE_ORIGIN}/sitemap.xml`);
      expect(result.host).toBe(SITE_ORIGIN);
    });

    it('keeps the live device surface out of the index', () => {
      const [rule] = [robots().rules].flat();
      expect(rule.disallow).toContain('/remote');
      expect(PUBLIC_ROUTES).not.toContain('/remote');
    });

    it('lists every public route as an absolute URL', () => {
      const entries = sitemap();
      expect(entries.map((entry) => entry.url)).toEqual(
        PUBLIC_ROUTES.map((route) => new URL(route, SITE_ORIGIN).toString())
      );
    });

    it('stamps a reproducible lastmod so a rebuild is not a content change', () => {
      const first = sitemap().map((entry) => entry.lastModified?.toString());
      const second = sitemap().map((entry) => entry.lastModified?.toString());
      expect(first).toEqual(second);
    });
  });

  describe('resilience surfaces', () => {
    it.each(['app/error.tsx', 'app/global-error.tsx', 'app/not-found.tsx'])(
      '%s exists and default-exports a component',
      (file) => {
        expect(read(file)).toMatch(/export default function/);
      }
    );

    it('renders error boundaries on the client, where the failure happens', () => {
      for (const file of ['app/error.tsx', 'app/global-error.tsx']) {
        expect(read(file)).toContain("'use client'");
      }
    });

    it('gives a person the digest that ties the screen to a log line', () => {
      for (const file of ['app/error.tsx', 'app/global-error.tsx']) {
        expect(read(file)).toContain('error.digest');
      }
    });

    it('carries its own styles in the root boundary, which has no layout', () => {
      const global = read('app/global-error.tsx');
      expect(global).toContain('<html');
      expect(global).toContain('<body');
      expect(global).not.toMatch(/import '.*\.css'/);
    });

    it('keeps the 404 out of the index', () => {
      expect(read('app/not-found.tsx')).toMatch(/robots:\s*\{\s*index:\s*false/);
    });
  });

  describe('metadata', () => {
    const layout = read('app/layout.tsx');

    it('sets metadataBase so relative URLs resolve absolutely', () => {
      expect(layout).toContain('metadataBase: new URL(SITE_ORIGIN)');
    });

    it('declares Open Graph and Twitter cards', () => {
      expect(layout).toContain('openGraph:');
      expect(layout).toContain('twitter:');
    });

    it('backs the large summary card with a real generated image', () => {
      expect(layout).toContain("card: 'summary_large_image'");
      const og = read('app/opengraph-image.tsx');
      expect(og).toContain('ImageResponse');
      expect(og).toMatch(/width:\s*1200/);
      expect(og).toMatch(/height:\s*630/);
    });

    it('gives every public page its own title and canonical', () => {
      for (const route of PUBLIC_ROUTES.filter((entry) => entry !== '/')) {
        const page = read(`app${route}/page.tsx`);
        expect(page, `${route} metadata`).toContain('export const metadata');
        expect(page, `${route} canonical`).toContain(`canonical: '${route}'`);
      }
    });
  });

  describe('delivery headers', () => {
    const headers = read('public/_headers');

    it('pins HTTPS for the domain and its subdomains', () => {
      expect(headers).toMatch(/Strict-Transport-Security: max-age=\d+; includeSubDomains; preload/);
    });

    it('keeps the existing hardening intact', () => {
      for (const header of [
        'Content-Security-Policy:',
        'X-Content-Type-Options: nosniff',
        'X-Frame-Options: DENY',
        'Referrer-Policy: no-referrer',
        'Cross-Origin-Opener-Policy: same-origin'
      ]) {
        expect(headers).toContain(header);
      }
    });

    it('states the share card type, which nosniff would otherwise reject', () => {
      expect(headers).toMatch(/\/opengraph-image\n\s+Content-Type: image\/png/);
    });

    it('caches fingerprinted assets immutably', () => {
      expect(headers).toMatch(/\/_next\/static\/\*\n\s+Cache-Control: public, max-age=31536000, immutable/);
    });
  });

  describe('keyboard entry', () => {
    it('offers a skip link ahead of the canvas chrome', () => {
      expect(read('app/layout.tsx')).toContain('hii-skip-link');
      expect(read('app/globals.css')).toContain('.hii-skip-link:focus-visible');
    });

    it('points the skip link at a landmark that exists on every surface', () => {
      const targets = ['app/not-found.tsx', 'app/error.tsx', 'components/auth/HiiWebAccess.tsx'];
      for (const file of targets) {
        expect(read(file), `${file} skip target`).toContain('id="hii-main"');
      }
    });
  });
});
