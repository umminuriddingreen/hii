// SPDX-License-Identifier: LicenseRef-BSL-1.1
import { execFileSync } from 'node:child_process';
import type { MetadataRoute } from 'next';
import { PUBLIC_ROUTES, SITE_ORIGIN } from '@/lib/site';

/**
 * `lastmod` has to be reproducible: stamping every build with `new Date()`
 * tells crawlers the pages changed when only the build did. Prefer the commit
 * the artifact was built from, honour SOURCE_DATE_EPOCH for reproducible
 * builds, and fall back to now only when neither is available.
 */
function lastModified(): Date {
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  if (Number.isFinite(epoch) && epoch > 0) return new Date(epoch * 1000);
  try {
    const iso = execFileSync('git', ['log', '-1', '--format=%cI'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const commitDate = new Date(iso);
    if (!Number.isNaN(commitDate.getTime())) return commitDate;
  } catch {
    // Not a git checkout (vendored tarball, container build) — fall through.
  }
  return new Date();
}

export default function sitemap(): MetadataRoute.Sitemap {
  const stamp = lastModified();
  return PUBLIC_ROUTES.map((route) => ({
    url: new URL(route, SITE_ORIGIN).toString(),
    lastModified: stamp,
    changeFrequency: 'weekly' as const,
    priority: route === '/' ? 1 : 0.7
  }));
}
