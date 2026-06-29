'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { createExchange, type UploadState } from './actions';

const initial: UploadState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      disabled={pending}
      className="rounded bg-black px-5 py-2 font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
    >
      {pending ? 'Creating…' : 'Create exchange link'}
    </button>
  );
}

export default function UploadPage() {
  const [state, formAction] = useFormState(createExchange, initial);

  return (
    <>
      <h1 className="text-2xl font-bold">New exchange</h1>
      <p className="mt-1 text-neutral-600">
        A file, terms, and a price become one shareable link.
      </p>

      {state.linkUrl && (
        <div className="mt-6 rounded border border-emerald-300 bg-emerald-50 p-4">
          <p className="text-emerald-700">Exchange created. Share this link:</p>
          <a href={state.linkUrl} className="mt-2 block break-all font-mono text-sm underline">
            {state.linkUrl}
          </a>
        </div>
      )}

      <form action={formAction} className="mt-6 space-y-4">
        <label className="block">
          <span className="text-sm text-neutral-600">Title</span>
          <input name="title" required className="mt-1 w-full rounded border border-neutral-300 bg-white px-3 py-2" />
        </label>

        <label className="block">
          <span className="text-sm text-neutral-600">Description (optional)</span>
          <textarea name="description" rows={2} className="mt-1 w-full rounded border border-neutral-300 bg-white px-3 py-2" />
        </label>

        <label className="block">
          <span className="text-sm text-neutral-600">Price (USD)</span>
          <input name="price" type="number" min="0" step="0.01" defaultValue="9.99" required className="mt-1 w-full rounded border border-neutral-300 bg-white px-3 py-2" />
        </label>

        <fieldset className="rounded border border-neutral-200 p-4">
          <legend className="px-1 text-sm text-neutral-600">Terms</legend>
          <label className="block">
            <span className="text-sm text-neutral-600">License name</span>
            <input name="license_name" defaultValue="Standard" className="mt-1 w-full rounded border border-neutral-300 bg-white px-3 py-2" />
          </label>
          <label className="mt-3 block">
            <span className="text-sm text-neutral-600">Exclusivity</span>
            <select name="exclusivity" className="mt-1 w-full rounded border border-neutral-300 bg-white px-3 py-2">
              <option value="non-exclusive">Non-exclusive</option>
              <option value="exclusive">Exclusive</option>
              <option value="lease">Lease</option>
            </select>
          </label>
          <label className="mt-3 block">
            <span className="text-sm text-neutral-600">Terms text (optional)</span>
            <textarea name="terms" rows={2} className="mt-1 w-full rounded border border-neutral-300 bg-white px-3 py-2" placeholder="What the buyer is allowed to do with this." />
          </label>
        </fieldset>

        <label className="block">
          <span className="text-sm text-neutral-600">File</span>
          <input name="file" type="file" required className="mt-1 block w-full text-sm" />
        </label>

        {state.error && <p className="text-red-600">{state.error}</p>}

        <SubmitButton />
      </form>
    </>
  );
}
