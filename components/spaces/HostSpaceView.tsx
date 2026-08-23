'use client';

import { useEffect, useState } from 'react';
import type { Space } from '@/lib/spaces/types';
import { HostPanel } from './HostPanel';
import { SpaceQr } from './SpaceQr';
import { hostSpaceApiPath, validateSpaceAccessUrl } from './space-surface';

export function HostSpaceView({ spaceId }: { spaceId: string }) {
  const [space, setSpace] = useState<Space | null>(null);
  const [accessUrl, setAccessUrl] = useState('');
  const [status, setStatus] = useState('Loading host view…');

  useEffect(() => {
    let current = true;
    void fetch(hostSpaceApiPath(spaceId))
      .then(async (response) => {
        const body = await response.json().catch(() => null) as
          | { space: Space; accessUrl: string }
          | { error?: { message?: string } }
          | null;
        if (!response.ok || !body || !('space' in body)) {
          throw new Error(body && 'error' in body ? body.error?.message : `Host view failed (${response.status}).`);
        }
        return body;
      })
      .then(
        (body) => {
          if (!current) return;
          setSpace(body.space);
          setAccessUrl(validateSpaceAccessUrl(body.accessUrl, body.space.id));
          setStatus('');
        },
        (caught) => {
          if (current) setStatus(caught instanceof Error ? caught.message : 'Host view unavailable.');
        }
      );
    return () => { current = false; };
  }, [spaceId]);

  if (!space || !accessUrl) return <main><p role="status">{status}</p><p><a href="/spaces">Back to Spaces</a></p></main>;
  return (
    <main className="hii-space-host-view">
      <header>
        <p>HII Space host</p>
        <h1>{space.name}</h1>
        <a href="/spaces">All Spaces</a>
      </header>
      <SpaceQr url={accessUrl} spaceName={space.name} />
      <HostPanel space={space} onSpaceChanged={setSpace} />
    </main>
  );
}
