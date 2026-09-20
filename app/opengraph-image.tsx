// SPDX-License-Identifier: LicenseRef-BSL-1.1
import { SITE_TAGLINE } from '@/lib/site';

export const alt = 'HII — Human Information Interface';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/**
 * The share card is the public surface rendered at card scale: white field,
 * monospace kicker, one tightly tracked line. Generated at build time so it can
 * never drift from the wordmark it is quoting.
 *
 * The card exists for link unfurls, which only the web surface has. The
 * desktop bundle is served over hiiui:// and is never unfurled, so it skips
 * the card entirely — which also keeps `next/og` out of the desktop build,
 * where its Windows path handling cannot prerender.
 */
export default async function OpengraphImage() {
  if (process.env.NEXT_PUBLIC_HII_TARGET === 'desktop' || process.platform === 'win32') {
    return new Response(null, { status: 404 });
  }
  const { ImageResponse } = await import('next/og');
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: 80,
          background: '#ffffff',
          color: '#000000'
        }}
      >
        <div style={{ fontSize: 26, letterSpacing: 4, display: 'flex' }}>HII</div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 116, letterSpacing: -6, lineHeight: 1.02, maxWidth: 940 }}>
            Human Information Interface
          </div>
          <div style={{ marginTop: 32, fontSize: 34, color: 'rgba(0,0,0,.48)', maxWidth: 900, display: 'flex' }}>
            {SITE_TAGLINE}
          </div>
        </div>
      </div>
    ),
    size
  );
}
