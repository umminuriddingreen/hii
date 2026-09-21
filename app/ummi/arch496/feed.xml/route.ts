// SPDX-License-Identifier: LicenseRef-BSL-1.1
import { SITE_ORIGIN } from '@/lib/site';

const items = [
  {
    title: 'Concept submission brief confirmed',
    date: 'Sat, 19 Sep 2026 15:15:00 GMT',
    guid: 'arch495-brief-20260919',
    description: 'One designed PDF is due September 22 at noon. It combines the written concept, thesis, three or more physical concept models, site collages, program diagram, synthetic site drawing, and graphic-language sources.'
  },
  {
    title: 'Program study is not building massing',
    date: 'Sun, 20 Sep 2026 21:53:55 GMT',
    guid: 'arch495-program-state-20260920',
    description: 'The current color-coded Rhino volumes test square footage, scale, and proximity. HII records them as a program study so they are not misrepresented as final architectural massing.'
  },
  {
    title: 'Situated landscape experience enters HII',
    date: 'Sun, 20 Sep 2026 21:55:00 GMT',
    guid: 'arch495-hii-experience-20260920',
    description: 'The project case study now frames the museum as a distributed landscape experience with location-aware impressions, physical thresholds, and source-linked agent work.'
  },
  {
    title: 'ARCH495/496 objective thread opened',
    date: 'Sun, 20 Sep 2026 21:53:55 GMT',
    guid: 'arch495-hii-thread-20260920',
    description: 'A private HII objective thread tracks the hybrid digital-physical museum, Rhino design, QGIS evidence, local-model processing, verified artifacts, and the UMMI case study.'
  }
];

function xml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function GET() {
  const page = new URL('/ummi/arch496', SITE_ORIGIN).toString();
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>UMMI · Museum of the American Landscape</title>
    <link>${xml(page)}</link>
    <description>Source-linked progress from the ARCH495/496 landscape museum project.</description>
    <language>en-us</language>
    <lastBuildDate>Sun, 20 Sep 2026 22:00:00 GMT</lastBuildDate>
    <atom:link href="${xml(new URL('/ummi/arch496/feed.xml', SITE_ORIGIN).toString())}" rel="self" type="application/rss+xml" />
${items.map((item) => `    <item>
      <title>${xml(item.title)}</title>
      <link>${xml(`${page}#${item.guid}`)}</link>
      <guid isPermaLink="false">${xml(item.guid)}</guid>
      <pubDate>${item.date}</pubDate>
      <description>${xml(item.description)}</description>
    </item>`).join('\n')}
  </channel>
</rss>`;

  return new Response(body, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300'
    }
  });
}
