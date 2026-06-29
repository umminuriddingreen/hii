import Link from 'next/link';

export default function Home() {
  return (
    <>
      <h1 className="text-2xl font-bold">Sell one track. Get one link.</h1>
      <p className="mt-3 text-neutral-600">
        Upload an audio file, set a price and license, and send a single link. The buyer previews,
        pays, and downloads — and you see exactly who downloaded.
      </p>

      <div className="mt-8 flex gap-4">
        <Link
          href="/upload"
          className="rounded bg-black px-5 py-2 font-medium text-white hover:bg-neutral-800"
        >
          Upload a track →
        </Link>
      </div>

      <p className="mt-10 text-xs text-neutral-400">v1 spine · identity → information → exchange</p>
    </>
  );
}
