import Link from 'next/link';
import { landing, type ContentItem } from '@/lib/landing';

// A YouTube/Vimeo embed URL is shown in an <iframe>; a direct file
// (e.g. .mp4/.webm) is shown in a <video> player.
function isEmbed(url: string) {
  return /youtube\.com\/embed|player\.vimeo\.com|youtu\.be/.test(url);
}
function isPdf(url: string) {
  return /\.pdf($|\?)/i.test(url);
}

function ContentBlock({ item }: { item: ContentItem }) {
  return (
    <section className="border-b border-neutral-200 py-10">
      {item.title && <h2 className="mb-3 text-lg font-semibold">{item.title}</h2>}

      {item.type === 'photo' && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.url} alt={item.title ?? ''} className="w-full rounded" />
      )}

      {item.type === 'video' &&
        (isEmbed(item.url) ? (
          <div className="aspect-video w-full">
            <iframe
              src={item.url}
              title={item.title ?? 'video'}
              allowFullScreen
              className="h-full w-full rounded"
            />
          </div>
        ) : (
          <video src={item.url} controls className="w-full rounded" />
        ))}

      {item.type === 'document' &&
        (isPdf(item.url) ? (
          <iframe
            src={item.url}
            title={item.title ?? 'document'}
            className="h-[600px] w-full rounded border border-neutral-200"
          />
        ) : (
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            className="block rounded border border-neutral-200 bg-neutral-50 p-6 text-center hover:bg-neutral-100"
          >
            📄 Open document
          </a>
        ))}

      {item.caption && <p className="mt-3 text-sm text-neutral-500">{item.caption}</p>}

      {item.buyUrl && (
        <Link
          href={item.buyUrl}
          className="mt-4 inline-block rounded bg-black px-5 py-2 font-medium text-white hover:bg-neutral-800"
        >
          Buy &amp; download →
        </Link>
      )}
    </section>
  );
}

export default function LandingPage() {
  return (
    <>
      <header className="py-6">
        <h1 className="text-3xl font-bold">{landing.name}</h1>
        <p className="mt-2 text-neutral-600">{landing.tagline}</p>
      </header>

      {landing.content.map((item, i) => (
        <ContentBlock key={i} item={item} />
      ))}

      <p className="py-8 text-xs text-neutral-400">
        Customize this page by editing <code>lib/landing.ts</code>.
      </p>
    </>
  );
}
