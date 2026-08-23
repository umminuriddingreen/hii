'use client';

import { useEffect, useState } from 'react';
import { EcosystemEntry } from '@/components/ecosystem';
import type { Space, SpaceSummary } from '@/lib/spaces/types';
import { CreateSpace, type CreateSpaceRequest } from './CreateSpace';
import { HostSpaceView } from './HostSpaceView';
import { SpaceCanvas } from './SpaceCanvas';
import {
  HOST_SPACES_API,
  hiiProductRouteFromPathname,
  type HiiProductRoute
} from './space-surface';

type HostSpaceSummary = SpaceSummary & { accessUrl?: string };

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as
    | { error?: { message?: string } }
    | T
    | null;
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body
      ? body.error?.message
      : undefined;
    throw new Error(message || `HII Spaces request failed (${response.status}).`);
  }
  return body as T;
}

async function createSpaceThroughHost(request: CreateSpaceRequest) {
  const response = await fetch(HOST_SPACES_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: request.name })
  });
  return responseJson<{ space: Space; accessUrl: string }>(response);
}

export function SpacesHome() {
  const [spaces, setSpaces] = useState<HostSpaceSummary[]>([]);
  const [status, setStatus] = useState('Loading Spaces…');

  useEffect(() => {
    let current = true;
    void fetch(HOST_SPACES_API)
      .then((response) => responseJson<{ spaces: HostSpaceSummary[] }>(response))
      .then(
        ({ spaces: listed }) => {
          if (!current) return;
          setSpaces(listed);
          setStatus(listed.length ? '' : 'No Spaces yet.');
        },
        (caught) => {
          if (current) setStatus(caught instanceof Error ? caught.message : 'Spaces are unavailable.');
        }
      );
    return () => { current = false; };
  }, []);

  return (
    <main className="hii-spaces-home">
      <header>
        <p>HII Spaces</p>
        <h1>Every place can have a space.</h1>
        <p>Create a shared digital surface, attach it to a QR code, and let it live on your hardware.</p>
        <a className="hii-spaces-create-link" href="/new">Create a Space</a>
      </header>
      <section aria-labelledby="hii-your-spaces">
        <h2 id="hii-your-spaces">Your Spaces</h2>
        <p role="status" aria-live="polite">{status}</p>
        <ul>
          {spaces.map((space) => (
            <li key={space.id}>
              <a href={`/host/s/${space.id}`}>{space.name}</a>
              <span>{space.publicationState === 'published' ? 'Published' : 'Local'}</span>
            </li>
          ))}
        </ul>
      </section>
      <p><a href="/">Back to Workspace</a></p>
    </main>
  );
}

export function HiiProductEntry() {
  const [route, setRoute] = useState<HiiProductRoute | null>(null);
  useEffect(() => setRoute(hiiProductRouteFromPathname(window.location.pathname)), []);
  if (!route) return <main aria-label="Opening HII" />;
  switch (route.kind) {
    case 'workspace': return <EcosystemEntry />;
    case 'spaces-home': return <SpacesHome />;
    case 'space-new': return (
      <CreateSpace ownerId="operator:local" onCreateWithAccess={createSpaceThroughHost} />
    );
    case 'space-host': return <HostSpaceView spaceId={route.spaceId} />;
    case 'space-visitor': return <SpaceCanvas spaceId={route.spaceId} />;
    default: return <main><h1>Not found</h1><p><a href="/spaces">Open HII Spaces</a></p></main>;
  }
}
