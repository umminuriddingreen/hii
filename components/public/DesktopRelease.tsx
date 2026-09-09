// SPDX-License-Identifier: LicenseRef-BSL-1.1
'use client';

import { useEffect, useState } from 'react';

type Platform = 'macos' | 'windows';

type Release = {
  version?: string;
  filename?: string;
  bytes?: number;
  sha256?: string;
  createdAt?: string;
  signed?: boolean;
};

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; release: Release }
  | { kind: 'signed-out' }
  | { kind: 'absent' }
  | { kind: 'error'; message: string };

function validRelease(value: unknown): value is Release {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const release = value as Release;
  return typeof release.version === 'string' && release.version.trim().length > 0
    && typeof release.filename === 'string' && /^[A-Za-z0-9_.-]+$/.test(release.filename)
    && typeof release.bytes === 'number' && Number.isSafeInteger(release.bytes) && release.bytes > 0
    && typeof release.sha256 === 'string' && /^[a-fA-F0-9]{64}$/.test(release.sha256)
    && (release.createdAt === undefined || typeof release.createdAt === 'string' && Number.isFinite(Date.parse(release.createdAt)));
}

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
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setState({ kind: 'loading' });
    fetch(`/download/${platform}.json`, { credentials: 'include', cache: 'no-store' })
      .then(async (response) => {
        if (!live) return;
        if (response.status === 401) {
          setState({ kind: 'signed-out' });
          return;
        }
        if (response.status === 404) {
          setState({ kind: 'absent' });
          return;
        }
        if (!response.ok) {
          setState({ kind: 'error', message: 'The download service could not check this build.' });
          return;
        }
        const release: unknown = await response.json().catch(() => null);
        if (!live) return;
        setState(validRelease(release)
          ? { kind: 'ready', release }
          : { kind: 'error', message: 'The published build information is incomplete or invalid.' });
      })
      .catch(() => {
        if (live) setState({ kind: 'error', message: 'Could not reach the download service. Check your connection.' });
      });
    return () => {
      live = false;
    };
  }, [platform, attempt]);

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

  if (state.kind === 'error') {
    return <p className="release-facts" role="status">
      {state.message}{' '}
      <button type="button" onClick={() => setAttempt((value) => value + 1)}>Try again</button>
    </p>;
  }

  const { version, bytes, sha256, createdAt } = state.release;

  return (
    <>
      <p>
        <a className="release-download" href={`/download/${platform}`}>
          {label}
          {version ? ` — ${version}` : ''}
        </a>
      </p>
      <dl className="release-facts">
        {typeof bytes === 'number' ? (
          <>
            <dt>Size</dt>
            <dd>{megabytes(bytes)}</dd>
          </>
        ) : null}
        {createdAt ? (
          <>
            <dt>Published</dt>
            <dd>{new Date(createdAt).toISOString().slice(0, 10)}</dd>
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
