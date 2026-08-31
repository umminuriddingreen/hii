// SPDX-License-Identifier: LicenseRef-BSL-1.1
'use client';

import { useEffect } from 'react';

/**
 * Root error boundary. This replaces the root layout entirely, so it cannot
 * rely on anything the layout provides — styles are inlined deliberately.
 */
export default function GlobalError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[hii] global error', error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: 'clamp(24px, 6vw, 96px)',
          background: '#ffffff',
          color: '#000000',
          fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif'
        }}
      >
        <p style={{ margin: 0, font: '12px "SF Mono", ui-monospace, monospace', letterSpacing: '.12em' }}>
          HII / Error
        </p>
        <h1
          style={{
            maxWidth: '12ch',
            margin: '32px 0 0',
            fontSize: 'clamp(44px, 9vw, 120px)',
            letterSpacing: '-.075em',
            lineHeight: 0.85
          }}
        >
          HII stopped.
        </h1>
        <p style={{ maxWidth: '44rem', margin: '40px 0 0', fontSize: 'clamp(18px, 2vw, 26px)', lineHeight: 1.4 }}>
          The interface failed to start. Nothing on your computer was changed. Reloading rebuilds
          this surface from scratch.
        </p>
        {error.digest ? (
          <p style={{ margin: '20px 0 0', color: 'rgba(0,0,0,.48)', font: '12px "SF Mono", ui-monospace, monospace' }}>
            Reference {error.digest}
          </p>
        ) : null}
        <p style={{ margin: '40px 0 0' }}>
          <button
            type="button"
            onClick={reset}
            style={{
              padding: '10px 18px',
              border: '1px solid currentColor',
              borderRadius: 8,
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              cursor: 'pointer'
            }}
          >
            Reload HII
          </button>
        </p>
      </body>
    </html>
  );
}
