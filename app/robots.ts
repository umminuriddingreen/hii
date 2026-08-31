// SPDX-License-Identifier: LicenseRef-BSL-1.1
import type { MetadataRoute } from 'next';
import { SITE_ORIGIN } from '@/lib/site';

/**
 * `/remote` is a live device surface, not a document, and `/admin` is the
 * operator view. Both are reachable but neither should be indexed or
 * resurfaced out of context.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/remote', '/admin'] }],
    sitemap: `${SITE_ORIGIN}/sitemap.xml`,
    host: SITE_ORIGIN
  };
}
