// SPDX-License-Identifier: LicenseRef-BSL-1.1
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Not found',
  description: 'That address does not resolve to anything on HII.',
  robots: { index: false, follow: true }
};

export default function NotFound() {
  return (
    <main className="public-home" id="hii-main">
      <p className="public-name">HII / 404</p>
      <h1>Nothing is here.</h1>
      <p>
        That address does not resolve to anything HII publishes. Nothing was lost — this surface
        just has no page at that path.
      </p>
      <nav>
        <a href="/">Home</a>
        <a href="/docs">Documentation</a>
        <a href="/download">Download</a>
      </nav>
    </main>
  );
}
