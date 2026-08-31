// SPDX-License-Identifier: LicenseRef-BSL-1.1
import type { MetadataRoute } from 'next';
import { SITE_ORIGIN } from '@/lib/site';

/**
 * `/remote` is a live device surface, not a document: it is reachable but not
 * something a crawler should index or resurface out of context.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/remote'] }],
    sitemap: `${SITE_ORIGIN}/sitemap.xml`,
    host: SITE_ORIGIN
  };
}
