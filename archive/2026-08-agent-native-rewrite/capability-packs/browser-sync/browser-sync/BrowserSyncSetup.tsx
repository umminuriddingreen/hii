'use client';

import { useState } from 'react';

type RelayStatus = 'idle' | 'testing' | 'ready' | 'error';

export function BrowserSyncSetup() {
  const [syncKey, setSyncKey] = useState('');
  const [relayStatus, setRelayStatus] = useState<RelayStatus>('idle');
  const [message, setMessage] = useState('');

  function generateKey() {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    setSyncKey(Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''));
    setRelayStatus('idle');
    setMessage('Generated locally. Copy this same key into both browser extensions.');
  }

  async function testRelay() {
    if (syncKey.length < 20) {
      setRelayStatus('error');
      setMessage('Use a sync key of at least 20 characters.');
      return;
    }
    setRelayStatus('testing');
    setMessage('Testing the local Next.js relay…');
    try {
      const response = await fetch('/api/browser-sync', {
        headers: { 'x-hii-sync-key': syncKey },
        cache: 'no-store'
      });
      const result = await response.json() as { revision?: number; error?: string };
      if (!response.ok) throw new Error(result.error || `Relay returned ${response.status}`);
      setRelayStatus('ready');
      setMessage(`Relay ready. Current sync revision: ${result.revision ?? 0}.`);
    } catch (error) {
      setRelayStatus('error');
      setMessage(error instanceof Error ? error.message : 'Could not reach the local relay.');
    }
  }

  async function copyKey() {
    if (!syncKey) return;
    await navigator.clipboard.writeText(syncKey);
    setMessage('Sync key copied. Paste it into the extension Options page in Helium and Chrome.');
  }

  return (
    <section className="hii-sync-card" aria-labelledby="pair-heading">
      <p className="hii-sync-eyebrow">React setup control</p>
      <h2 id="pair-heading">Pair Helium and Chrome</h2>
      <p>The key stays on this Mac and selects an isolated record set inside the HII runtime.</p>
      <label htmlFor="sync-key">Shared sync key</label>
      <input
        id="sync-key"
        type="password"
        value={syncKey}
        minLength={20}
        autoComplete="new-password"
        onChange={(event) => setSyncKey(event.target.value)}
        placeholder="20 or more characters"
      />
      <div className="hii-sync-actions">
        <button type="button" onClick={generateKey}>Generate key</button>
        <button type="button" onClick={copyKey} disabled={!syncKey}>Copy key</button>
        <button type="button" onClick={testRelay} disabled={relayStatus === 'testing'}>
          {relayStatus === 'testing' ? 'Testing…' : 'Test Next.js relay'}
        </button>
      </div>
      <p className={`hii-sync-status is-${relayStatus}`} role="status">{message}</p>
    </section>
  );
}
