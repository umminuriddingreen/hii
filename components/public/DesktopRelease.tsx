// SPDX-License-Identifier: LicenseRef-BSL-1.1
'use client';

import { useEffect, useState } from 'react';

type Platform = 'macos' | 'windows';

type Release = {
  version?: string;
  filename?: string;
  size?: number;
  sha256?: string;
  publishedAt?: string;
};

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; release: Release }
  | { kind: 'signed-out' }
  | { kind: 'absent' };

function megabytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The download page is a static export, so it cannot know what is in R2 at
 * build time — and the manifest is behind the same session gate as the
 * artifact. So the facts are fetched at read time, and the three honest
 * outcomes are stated plainly: here is the build, sign in first, or there is
 * no build for this platform yet. Nothing is hardcoded that could go stale.
 */
export function DesktopRelease({ platform, label }: { platform: Platform; label: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    fetch(`/download/${platform}.json`, { credentials: 'include' })
      .then(async (response) => {
        if (!live) return;
        if (response.status === 401) {
          setState({ kind: 'signed-out' });
          return;
        }
        if (!response.ok) {
          setState({ kind: 'absent' });
          return;
        }
        setState({ kind: 'ready', release: (await response.json()) as Release });
      })
      .catch(() => {
        if (live) setState({ kind: 'absent' });
      });
    return () => {
      live = false;
    };
  }, [platform]);

  if (state.kind === 'loading') {
    return <p className="release-facts">Checking for a build&hellip;</p>;
  }

  if (state.kind === 'signed-out') {
    return (
      <p className="release-facts">
        <a href="/">Sign in</a> to download. Builds are account-gated during the private beta.
      </p>
    );
  }

  if (state.kind === 'absent') {
    return <p className="release-facts">No build published for this platform yet.</p>;
  }

  const { version, size, sha256, publishedAt } = state.release;

  return (
    <>
      <p>
        <a className="release-download" href={`/download/${platform}`}>
          {label}
          {version ? ` — ${version}` : ''}
        </a>
      </p>
      <dl className="release-facts">
        {typeof size === 'number' ? (
          <>
            <dt>Size</dt>
            <dd>{megabytes(size)}</dd>
          </>
        ) : null}
        {publishedAt ? (
          <>
            <dt>Published</dt>
            <dd>{new Date(publishedAt).toISOString().slice(0, 10)}</dd>
          </>
        ) : null}
        {sha256 ? (
          <>
            <dt>SHA-256</dt>
            <dd><code>{sha256}</code></dd>
          </>
        ) : null}
      </dl>
    </>
  );
}
