'use client';

import { useState, type FormEvent } from 'react';
import type { Space } from '@/lib/spaces/types';
import { hostSpaceControlsApiPath } from './space-surface';

type PolicyMode =
  | 'LOCAL_READ_LOCAL_WRITE'
  | 'PUBLIC_READ_LOCAL_WRITE'
  | 'PUBLIC_READ_ONLY'
  | 'INVITE_ONLY';

type HostControl =
  | { action: 'set-writes-frozen'; value: boolean }
  | { action: 'set-uploads-enabled'; value: boolean }
  | { action: 'set-upload-limits'; maxUploadBytes?: number; storageQuotaBytes?: number; maxObjects?: number }
  | { action: 'set-policy-mode'; mode: PolicyMode }
  | { action: 'remove-object'; objectId: string }
  | { action: 'remove-participant'; participantId: string }
  | { action: 'clear-space' }
  | { action: 'create-invite' };

type HostControlResponse = { ok: true; space?: Space; invite?: string };

export function HostPanel({ space, onSpaceChanged }: { space: Space; onSpaceChanged(space: Space): void }) {
  const [status, setStatus] = useState('');
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);

  async function apply(control: HostControl) {
    setBusy(true);
    setStatus('Applying host control…');
    try {
      const response = await fetch(hostSpaceControlsApiPath(space.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(control)
      });
      const body = await response.json().catch(() => null) as
        | HostControlResponse
        | { error?: { message?: string } }
        | null;
      if (!response.ok || !body || !('ok' in body)) {
        throw new Error(body && 'error' in body ? body.error?.message : `Control failed (${response.status}).`);
      }
      if (body.space) onSpaceChanged(body.space);
      if (body.invite) setInvite(body.invite);
      setStatus('Host control applied.');
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : 'Host control failed.');
    } finally {
      setBusy(false);
    }
  }

  function updateLimits(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void apply({
      action: 'set-upload-limits',
      maxUploadBytes: Number(data.get('maxUploadBytes')),
      storageQuotaBytes: Number(data.get('storageQuotaBytes')),
      maxObjects: Number(data.get('maxObjects'))
    });
  }

  function removeObject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const objectId = String(new FormData(event.currentTarget).get('objectId') ?? '').trim();
    if (objectId) void apply({ action: 'remove-object', objectId });
  }

  function removeParticipant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const participantId = String(new FormData(event.currentTarget).get('participantId') ?? '').trim();
    if (participantId) void apply({ action: 'remove-participant', participantId });
  }

  return (
    <section className="hii-space-host-panel" aria-labelledby="hii-space-host-controls">
      <h2 id="hii-space-host-controls">Host controls</h2>
      <p>These controls are available only through HII’s loopback operator listener.</p>
      <div>
        <button type="button" disabled={busy} onClick={() => void apply({ action: 'set-writes-frozen', value: !space.policy.writesFrozen })}>
          {space.policy.writesFrozen ? 'Unfreeze writes' : 'Freeze writes'}
        </button>
        <button type="button" disabled={busy} onClick={() => void apply({ action: 'set-uploads-enabled', value: !space.policy.uploadsEnabled })}>
          {space.policy.uploadsEnabled ? 'Disable uploads' : 'Enable uploads'}
        </button>
      </div>
      <label htmlFor="hii-space-policy">Space policy</label>
      <select
        id="hii-space-policy"
        disabled={busy}
        defaultValue="LOCAL_READ_LOCAL_WRITE"
        onChange={(event) => void apply({ action: 'set-policy-mode', mode: event.currentTarget.value as PolicyMode })}
      >
        <option value="LOCAL_READ_LOCAL_WRITE">Local read / local write</option>
        <option value="PUBLIC_READ_LOCAL_WRITE">Public read / local write</option>
        <option value="PUBLIC_READ_ONLY">Public read only</option>
        <option value="INVITE_ONLY">Invite only</option>
      </select>
      <form onSubmit={updateLimits}>
        <label htmlFor="hii-space-upload-limit">Maximum upload bytes</label>
        <input id="hii-space-upload-limit" name="maxUploadBytes" type="number" min="1" defaultValue={space.policy.maxUploadBytes} required />
        <label htmlFor="hii-space-object-limit">Maximum objects</label>
        <input id="hii-space-object-limit" name="maxObjects" type="number" min="1" defaultValue={space.policy.maxObjects} required />
        <label htmlFor="hii-space-storage-quota">Storage quota bytes</label>
        <input id="hii-space-storage-quota" name="storageQuotaBytes" type="number" min="1" defaultValue={space.policy.storageQuotaBytes} required />
        <button type="submit" disabled={busy}>Save limits</button>
      </form>
      <form onSubmit={removeObject}>
        <label htmlFor="hii-space-remove-object">Remove object by ID</label>
        <input id="hii-space-remove-object" name="objectId" required autoComplete="off" />
        <button type="submit" disabled={busy}>Remove object</button>
      </form>
      <form onSubmit={removeParticipant}>
        <label htmlFor="hii-space-remove-participant">Remove participant by ID</label>
        <input id="hii-space-remove-participant" name="participantId" required autoComplete="off" />
        <button type="submit" disabled={busy}>Remove participant</button>
      </form>
      <button type="button" disabled={busy} onClick={() => void apply({ action: 'create-invite' })}>Create invite</button>
      {invite ? <p className="hii-space-invite">Invite token: <code>{invite}</code></p> : null}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (window.confirm('Clear every object from this Space?')) void apply({ action: 'clear-space' });
        }}
      >
        Clear Space
      </button>
      <p role="status" aria-live="polite">{status}</p>
    </section>
  );
}
