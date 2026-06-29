import { notFound } from 'next/navigation';
import { getTrack, getDownloadCount } from '@/lib/server/tracks';

export default async function AssetPage({ params }: { params: { id: string } }) {
  const track = await getTrack(params.id);
  if (!track) notFound();

  const downloadCount = await getDownloadCount(track.id);
  const price = (track.price_cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: track.currency.toUpperCase()
  });

  return (
    <>
      <h1 className="text-2xl font-bold">{track.title}</h1>
      <p className="mt-1 text-neutral-600">
        {track.license} license · {price}
      </p>

      {/* Preview: a watermarked clip will go here; raw file stays locked until paid */}
      <div className="mt-6 rounded border border-neutral-200 bg-neutral-50 p-6 text-center text-neutral-500">
        ♪ preview clip (coming after payment path proves out)
      </div>

      <form method="POST" action="/api/checkout" className="mt-6">
        <input type="hidden" name="track_id" value={track.id} />
        <button className="w-full rounded bg-black px-5 py-3 font-medium text-white hover:bg-neutral-800">
          Buy &amp; download — {price}
        </button>
      </form>

      <p className="mt-8 text-xs text-neutral-400">Downloads so far: {downloadCount}</p>
    </>
  );
}
