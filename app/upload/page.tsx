'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { createTrack, type UploadState } from './actions';

const initial: UploadState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      disabled={pending}
      className="rounded bg-emerald-500 px-5 py-2 font-medium text-black hover:bg-emerald-400 disabled:opacity-50"
    >
      {pending ? 'Uploading…' : 'Create link'}
    </button>
  );
}

export default function UploadPage() {
  const [state, formAction] = useFormState(createTrack, initial);

  return (
    <>
      <h1 className="text-2xl font-bold">Upload a track</h1>

      {state.assetUrl && (
        <div className="mt-6 rounded border border-emerald-700 bg-emerald-950/40 p-4">
          <p className="text-emerald-300">Track created. Send this link to your buyer:</p>
          <a href={state.assetUrl} className="mt-2 block break-all font-mono text-sm underline">
            {state.assetUrl}
          </a>
        </div>
      )}

      <form action={formAction} className="mt-6 space-y-4">
        <label className="block">
          <span className="text-sm text-neutral-400">Title</span>
          <input name="title" required className="mt-1 w-full rounded bg-neutral-900 px-3 py-2" />
        </label>

        <label className="block">
          <span className="text-sm text-neutral-400">Price (USD)</span>
          <input
            name="price"
            type="number"
            min="0"
            step="0.01"
            defaultValue="9.99"
            required
            className="mt-1 w-full rounded bg-neutral-900 px-3 py-2"
          />
        </label>

        <label className="block">
          <span className="text-sm text-neutral-400">License</span>
          <select name="license" className="mt-1 w-full rounded bg-neutral-900 px-3 py-2">
            <option value="non-exclusive">Non-exclusive</option>
            <option value="exclusive">Exclusive</option>
            <option value="lease">Lease</option>
          </select>
        </label>

        <label className="block">
          <span className="text-sm text-neutral-400">Audio file</span>
          <input
            name="file"
            type="file"
            accept="audio/*"
            required
            className="mt-1 block w-full text-sm"
          />
        </label>

        {state.error && <p className="text-red-400">{state.error}</p>}

        <SubmitButton />
      </form>
    </>
  );
}
