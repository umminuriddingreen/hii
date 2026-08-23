'use client';

import { useState, type FormEvent } from 'react';
import type { Space } from '@/lib/spaces/types';
import {
  buildLocalSpaceUrl,
  createSpaceFromName,
  trustedSpaceOrigin,
  type CreateSpaceCallback,
  type CreateSpaceRequest
} from '@/lib/spaces/access-link';
import { SpaceQr, type OfflineQrRenderer } from './SpaceQr';
import { validateSpaceAccessUrl } from './space-surface';

export { createSpaceFromName } from '@/lib/spaces/access-link';
export type { CreateSpaceCallback, CreateSpaceRequest } from '@/lib/spaces/access-link';

export type CreateSpaceProps = {
  ownerId: string;
  localOrigin?: string;
  onCreate?: CreateSpaceCallback;
  onCreateWithAccess?: (
    request: CreateSpaceRequest
  ) => Promise<{ space: Space; accessUrl: string }>;
  renderQr?: OfflineQrRenderer;
};

/**
 * Client create flow. Persistence remains outside the browser component: the
 * application passes a callback wired to its canonical server/runtime store.
 */
export function CreateSpace({
  ownerId,
  localOrigin,
  onCreate,
  onCreateWithAccess,
  renderQr
}: CreateSpaceProps) {
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ space: Space; accessUrl: string } | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      if (onCreateWithAccess) {
        let result: { space: Space; accessUrl: string } | undefined;
        const space = await createSpaceFromName(name, ownerId, async (request) => {
          result = await onCreateWithAccess(request);
          return result.space;
        });
        if (!result) throw new Error('The HII host returned no Space.');
        setCreated({
          space,
          accessUrl: validateSpaceAccessUrl(result.accessUrl, space.id)
        });
      } else {
        if (!onCreate || !localOrigin) throw new Error('Space creation is unavailable.');
        trustedSpaceOrigin(localOrigin);
        const space = await createSpaceFromName(name, ownerId, onCreate);
        setCreated({ space, accessUrl: buildLocalSpaceUrl(space.id, localOrigin) });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The Space could not be created.');
    } finally {
      setSubmitting(false);
    }
  }

  if (created) {
    return (
      <main className="hii-space-created">
        <p className="hii-space-created-status" role="status">
          Space created.
        </p>
        <SpaceQr
          url={created.accessUrl}
          spaceName={created.space.name}
          renderQr={renderQr}
        />
        <p><a href={`/host/s/${created.space.id}`}>Open host controls</a></p>
      </main>
    );
  }

  return (
    <main className="hii-space-create">
      <h1>Create a Space</h1>
      <p>Create a shared digital surface that lives on your hardware.</p>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="hii-space-name">Space name</label>
        <input
          id="hii-space-name"
          name="name"
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          autoComplete="off"
          required
          disabled={submitting}
        />
        <button type="submit" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create Space'}
        </button>
      </form>
      <p className="hii-space-create-error" role="alert">
        {error}
      </p>
    </main>
  );
}
