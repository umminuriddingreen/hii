/**
 * ───────────────────────────────────────────────────────────────
 *  YOUR LANDING PAGE — edit everything here.
 * ───────────────────────────────────────────────────────────────
 *  This is the only file you touch to customize your page.
 *  Change the name/tagline, and add/remove/reorder content items.
 *  The page at /landing renders whatever you put in `content` below,
 *  top to bottom. No code knowledge needed — just edit the values.
 *
 *  Each content item has a `type`:
 *    'photo'    — shows an image.           url = image link
 *    'video'    — shows a video player or YouTube/Vimeo embed.
 *    'document' — shows a PDF preview or a download card.
 *
 *  Optional on any item: `title`, `caption`, and `buyUrl`
 *  (link to a paid track page, e.g. "/t/<id>", to sell it).
 */

export type ContentItem = {
  type: 'photo' | 'video' | 'document';
  url: string;
  title?: string;
  caption?: string;
  buyUrl?: string;
};

export type Landing = {
  name: string;
  tagline: string;
  content: ContentItem[];
};

export const landing: Landing = {
  name: 'Your Name',
  tagline: 'Producer · artist · creator — exchange a file for value.',

  content: [
    {
      type: 'photo',
      url: 'https://picsum.photos/seed/hii1/1200/800',
      title: 'Cover art',
      caption: 'Replace this with your own image URL.'
    },
    {
      type: 'video',
      url: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
      title: 'A video',
      caption: 'Paste a YouTube/Vimeo embed link or a direct .mp4 URL.'
    },
    {
      type: 'document',
      url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
      title: 'A document',
      caption: 'PDFs preview inline; anything else shows a download card.'
    }
  ]
};
