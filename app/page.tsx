import Link from 'next/link';

export default function Home() {
  return (
    <>
      <h1 className="text-2xl font-bold">Turn a file into an exchange link.</h1>
      <p className="mt-3 text-neutral-600">
        HII is a societal layer for exchanging content, goods, and services. The first primitive
        is simple: exchange a digital file for value. Upload an asset, set terms and a price, get
        one link, and track who gets access.
      </p>

      <div className="mt-8 flex gap-4">
        <Link
          href="/upload"
          className="rounded bg-black px-5 py-2 font-medium text-white hover:bg-neutral-800"
        >
          Create an exchange →
        </Link>
        <Link
          href="/login"
          className="rounded border border-neutral-300 px-5 py-2 font-medium hover:bg-neutral-50"
        >
          Sign in
        </Link>
      </div>

      <p className="mt-10 text-xs text-neutral-400">
        who · what · terms · value · transfer · proof
      </p>
    </>
  );
}
