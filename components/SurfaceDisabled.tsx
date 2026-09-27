import Link from 'next/link';

// Rendered when HII has disabled a surface in ~/.hii/config.json
// (docs/aii-hii-boundary.md). Re-enable with:
//   node ~/hii/runtime/daemon/hiid.mjs config set surfaces.<name>.enabled true
export function SurfaceDisabled({ name }: { name: string }) {
  return (
    <div className="hii-page flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
      <p className="hii-kicker">surface off</p>
      <h1 className="hii-page-title">“{name}” is turned off</h1>
      <p className="max-w-md text-sm opacity-70">
        HII has this surface disabled in your HII config. Re-enable it with{' '}
        <code>hiid config set surfaces.{name}.enabled true</code>.
      </p>
      <Link href="/" className="hii-side-link mt-2">
        back home
      </Link>
    </div>
  );
}
