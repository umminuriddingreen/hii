// SPDX-License-Identifier: LicenseRef-BSL-1.1
'use client';

import { useEffect } from 'react';

/**
 * Route-level error boundary.
 *
 * HII's contract is that a person can always see what happened, so this shows
 * the build's own error digest rather than a generic apology. The digest is the
 * only handle that ties a screen a person is looking at to a server log line.
 */
export default function RouteError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface the failure in the console for local debugging; nothing is transmitted.
    console.error('[hii] route error', error);
  }, [error]);

  return (
    <main className="public-home" id="hii-main">
      <p className="public-name">HII / Error</p>
      <h1>This view stopped.</h1>
      <p>
        Something in this page failed to render. Your work and your local data were not touched —
        the failure is in this surface, and retrying re-renders it from scratch.
      </p>
      {error.digest ? (
        <p className="public-detail">
          Reference <code>{error.digest}</code>
        </p>
      ) : null}
      <nav>
        <button type="button" className="public-action" onClick={reset}>
          Try again
        </button>
        <a href="/">Home</a>
      </nav>
    </main>
  );
}
