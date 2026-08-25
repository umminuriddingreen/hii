'use client';

import { useState } from 'react';

const SURFACES = [
  {
    id: 'hii',
    name: 'HII desktop',
    state: 'Windows now. Mac waiting on Apple notarization.',
    body: 'The local canvas and the hii runtime: context, approval, bounded work, proof, receipt. Every important operation works through the command line before it becomes a view.'
  },
  {
    id: 'context-dock',
    name: 'Context Dock',
    state: 'Building now. Loop not yet complete.',
    body: 'Project selection, visible source permissions, deterministic local inventory and extraction, and a source-linked project model — so an agent gets what it needs without anyone losing track of where it came from.'
  },
  {
    id: 'knowledge',
    name: 'Knowledge Workspace',
    state: 'Building now. Loop not yet complete.',
    body: 'Notes, folders, tags, links, backlinks, search, graph, history, import and export on a canonical local store at ~/.hii/hii.db. Obsidian and Markdown vaults import without mutating the source, and export back to portable files.'
  },
  {
    id: 'fabric',
    name: 'Machine fabric',
    state: 'One authenticated Mac/Windows link first. Not yet proven.',
    body: 'Explicitly scoped links between your own devices, carrying files, services, jobs, artifacts, and receipts. One proven device link comes before any remote capability claim.'
  },
  {
    id: 'concierge',
    name: 'AI to 3D concierge',
    state: 'Taking work now.',
    body: 'Plain-language request to editable Rhino geometry, run against your own project. This one is a session, not a download.'
  }
] as const;

type Status = { kind: 'idle' | 'sending' | 'done' | 'error'; message?: string };

export default function BuildingPage() {
  const [surface, setSurface] = useState<string>('hii');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (status.kind === 'sending') return;
    setStatus({ kind: 'sending' });

    try {
      const response = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, surface, note })
      });
      const body = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !body.ok) {
        setStatus({ kind: 'error', message: body.error || 'That did not go through. Try again shortly.' });
        return;
      }
      setStatus({ kind: 'done' });
    } catch {
      setStatus({ kind: 'error', message: 'The waitlist could not be reached. Check your connection and try again.' });
    }
  }

  return (
    <main className="public-home public-landing">
      <p className="public-name">HII / Building</p>

      <h1>What is being built.</h1>

      <p>
        HII ships one surface at a time, and only once it can show its work. This is what exists,
        what is in build, and what you can already have run against your own project.
      </p>

      <section className="public-section">
        <ul className="public-surfaces">
          {SURFACES.map((entry) => (
            <li key={entry.id}>
              <h3>{entry.name}</h3>
              <p className="public-state">{entry.state}</p>
              <p>{entry.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="public-section">
        <h2>Tell me which one you want.</h2>
        <p className="public-lede">
          One email when that surface is ready to use. Nothing else, and nothing sold on.
        </p>

        {status.kind === 'done' ? (
          <p className="public-waitlist-done" role="status">
            You are on the list. You will hear from{' '}
            <a href="mailto:hello@humaninformationinterface.com">hello@humaninformationinterface.com</a>{' '}
            when it is ready.
          </p>
        ) : (
          <form className="public-waitlist" onSubmit={submit}>
            <fieldset>
              <legend>Which surface?</legend>
              {SURFACES.map((entry) => (
                <label key={entry.id}>
                  <input
                    type="radio"
                    name="surface"
                    value={entry.id}
                    checked={surface === entry.id}
                    onChange={() => setSurface(entry.id)}
                  />
                  {entry.name}
                </label>
              ))}
            </fieldset>

            <label className="public-field">
              <span>Email</span>
              <input
                type="email"
                name="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>

            <label className="public-field">
              <span>What would you point it at? (optional)</span>
              <input
                type="text"
                name="note"
                maxLength={500}
                placeholder="A project, a problem, a file you are stuck in"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>

            <button type="submit" disabled={status.kind === 'sending'}>
              {status.kind === 'sending' ? 'Adding…' : 'Join the waitlist'}
            </button>

            {status.kind === 'error' && (
              <p className="public-waitlist-error" role="alert">
                {status.message}
              </p>
            )}
          </form>
        )}
      </section>

      <p className="public-fine">
        Your address is stored to send you that one message. It is never shown on the site and never
        passed to anyone else.
      </p>

      <nav>
        <a href="/">Home</a>
        <a href="/download">Download</a>
        <a href="/docs">Documentation</a>
        <a href="/privacy">Privacy</a>
      </nav>
    </main>
  );
}
