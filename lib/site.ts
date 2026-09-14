// SPDX-License-Identifier: LicenseRef-BSL-1.1
/**
 * Canonical public identity of the HII web surface.
 *
 * Route files (layout, sitemap, robots) may not export arbitrary values, so the
 * origin lives here and is imported where metadata is assembled. The override
 * exists so preview deployments describe themselves honestly instead of
 * claiming to be production.
 */
export const SITE_ORIGIN = process.env.NEXT_PUBLIC_HII_SITE_ORIGIN || 'https://humaninformationinterface.com';

export const SITE_NAME = 'HII';

export const SITE_TITLE = 'HII — Human Information Interface';

export const SITE_TAGLINE = 'A human information interface for working with agents.';

/** Public routes that are safe to advertise to crawlers. */
export const PUBLIC_ROUTES = ['/', '/docs', '/download', '/store', '/site-analysis', '/privacy'] as const;
