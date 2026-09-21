// SPDX-License-Identifier: LicenseRef-BSL-1.1
import type { MetadataRoute } from 'next';
import { SITE_ORIGIN } from '@/lib/site';

export const dynamic = 'force-static';

/**
 * `/remote` is a live device surface, not a document, so it must not be
 * indexed or resurfaced out of context.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/remote'] }],
    sitemap: `${SITE_ORIGIN}/sitemap.xml`,
    host: SITE_ORIGIN
  };
}
