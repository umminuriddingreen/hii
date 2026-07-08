'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { createExchange, type UploadState } from './actions';

const initial: UploadState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      disabled={pending}
      className="hii-command-button disabled:opacity-50"
    >
      {pending ? 'Creating…' : 'Create exchange link'}
    </button>
  );
}

export default function UploadPage() {
  const [state, formAction] = useFormState(createExchange, initial);

  return (
    <div className="hii-page max-w-3xl">
      <header className="hii-page-header">
        <p className="hii-kicker">HII exchange</p>
        <h1 className="hii-page-title">New exchange</h1>
        <p className="hii-page-copy">
        A file, terms, and a price become one shareable link.
        </p>
      </header>

      {state.linkUrl && (
        <div className="hii-card mt-6 bg-[var(--hii-soft-green)]">
          <p className="text-emerald-700">Exchange created. Share this link:</p>
          <a href={state.linkUrl} className="mt-2 block break-all font-mono text-sm underline">
            {state.linkUrl}
          </a>
        </div>
      )}

      <form action={formAction} className="hii-card mt-6 space-y-4">
        <label className="block">
          <span className="text-sm text-neutral-600">Title</span>
          <input name="title" required className="hii-field mt-1 w-full px-3 py-2" />
        </label>

        <label className="block">
          <span className="text-sm text-neutral-600">Description (optional)</span>
          <textarea name="description" rows={2} className="hii-textarea mt-1 w-full px-3 py-2" />
        </label>

        <label className="block">
          <span className="text-sm text-neutral-600">Price (USD)</span>
          <input name="price" type="number" min="0" step="0.01" defaultValue="9.99" required className="hii-field mt-1 w-full px-3 py-2" />
        </label>

        <fieldset className="border border-[rgba(23,107,255,0.24)] p-4">
          <legend className="px-1 text-sm text-neutral-600">Terms</legend>
          <label className="block">
            <span className="text-sm text-neutral-600">License name</span>
            <input name="license_name" defaultValue="Standard" className="hii-field mt-1 w-full px-3 py-2" />
          </label>
          <label className="mt-3 block">
            <span className="text-sm text-neutral-600">Exclusivity</span>
            <select name="exclusivity" className="hii-select mt-1 w-full px-3 py-2">
              <option value="non-exclusive">Non-exclusive</option>
              <option value="exclusive">Exclusive</option>
              <option value="lease">Lease</option>
            </select>
          </label>
          <label className="mt-3 block">
            <span className="text-sm text-neutral-600">Terms text (optional)</span>
            <textarea name="terms" rows={2} className="hii-textarea mt-1 w-full px-3 py-2" placeholder="What the buyer is allowed to do with this." />
          </label>
        </fieldset>

        <label className="block">
          <span className="text-sm text-neutral-600">File</span>
          <input name="file" type="file" required className="mt-1 block w-full text-sm" />
        </label>

        {state.error && <p className="text-red-600">{state.error}</p>}

        <SubmitButton />
      </form>
    </div>
  );
}
