// SPDX-License-Identifier: LicenseRef-BSL-1.1
'use client';

import { FormEvent, MouseEvent, useEffect, useRef, useState, WheelEvent } from 'react';

type Host = { id: string; name: string; online: boolean };
type Session = { authenticated: boolean; csrfToken?: string };
type Grant = { grantId: string; expiresAt: number };

export function RemoteBrowserViewer() {
  const [session, setSession] = useState<Session | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [hostId, setHostId] = useState('');
  const [url, setUrl] = useState('https://');
  const [browserLocation, setBrowserLocation] = useState('');
  const [frame, setFrame] = useState('');
  const [status, setStatus] = useState('Connect a paired Mac to browse.');
  const socket = useRef<WebSocket | null>(null);
  const grant = useRef<Grant | null>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const lastPointer = useRef(0);

  useEffect(() => {
    void Promise.all([
      fetch('/api/auth/session', { credentials: 'same-origin' }).then((response) => response.json()),
      fetch('/api/remote/hosts', { credentials: 'same-origin' }).then((response) => response.json()),
    ]).then(([account, machines]: [Session, { hosts?: Host[] }]) => {
      setSession(account);
      setHosts(machines.hosts ?? []);
      setHostId(machines.hosts?.find((host) => host.online)?.id ?? '');
    }).catch(() => setStatus('Sign in to use a paired browser.'));
    return () => { socket.current?.close(); };
  }, []);

  const revoke = async () => {
    socket.current?.close();
    socket.current = null;
    setFrame('');
    const active = grant.current;
    grant.current = null;
    if (active && session?.csrfToken) {
      await fetch(`/api/remote/browser-grants/${encodeURIComponent(active.grantId)}`, {
        method: 'DELETE', headers: { 'X-HII-CSRF': session.csrfToken }, credentials: 'same-origin',
      }).catch(() => {});
    }
  };

  const send = (value: Record<string, unknown>) => {
    if (socket.current?.readyState === WebSocket.OPEN && grant.current) {
      socket.current.send(JSON.stringify({ grantId: grant.current.grantId, ...value }));
    }
  };

  const open = async (event: FormEvent) => {
    event.preventDefault();
    if (!session?.csrfToken || !hostId) return;
    let target;
    try { target = new URL(url); } catch { setStatus('Enter a full http or https address.'); return; }
    if (!['http:', 'https:'].includes(target.protocol)) { setStatus('Only web addresses can open here.'); return; }
    if (socket.current?.readyState === WebSocket.OPEN) {
      send({ t: 'browser.navigate', url: target.href });
      return;
    }
    await revoke();
    setStatus('Connecting to the paired Mac…');
    try {
      const response = await fetch(`/api/remote/hosts/${encodeURIComponent(hostId)}/browser-grants`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-HII-CSRF': session.csrfToken },
        body: JSON.stringify({ ttlSeconds: 300 }),
      });
      if (!response.ok) throw new Error('Could not grant this browser session.');
      const issued = await response.json() as Grant;
      grant.current = issued;
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const next = new WebSocket(`${scheme}://${window.location.host}/api/remote/browser?grant=${encodeURIComponent(issued.grantId)}`);
      socket.current = next;
      next.addEventListener('open', () => send({ t: 'browser.open', url: target.href }));
      next.addEventListener('message', (message) => {
        if (typeof message.data !== 'string') return;
        let value: Record<string, unknown>;
        try { value = JSON.parse(message.data); } catch { return; }
        if (value.t === 'browser.frame' && typeof value.data === 'string') {
          setFrame(`data:image/jpeg;base64,${value.data}`);
          setStatus('Live browser');
        } else if (value.t === 'browser.location' && typeof value.url === 'string') {
          setBrowserLocation(value.url);
        } else if (value.t === 'browser.room' && value.hostOnline === false || value.t === 'browser.host-offline') {
          setStatus('Paired Mac is offline.');
          setFrame('');
        } else if (value.t === 'browser.error') {
          setStatus(String(value.error ?? 'Browser unavailable').replaceAll('_', ' '));
        }
      });
      next.addEventListener('close', () => { setStatus('Browser session ended.'); setFrame(''); });
      window.setTimeout(() => { if (grant.current?.grantId === issued.grantId) void revoke(); }, Math.max(0, issued.expiresAt - Date.now()));
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Browser unavailable.'); }
  };

  const point = (event: MouseEvent<HTMLImageElement> | WheelEvent<HTMLImageElement>) => {
    const bounds = image.current?.getBoundingClientRect();
    if (!bounds) return null;
    return { x: Math.max(0, Math.min(1280, (event.clientX - bounds.left) * 1280 / bounds.width)),
      y: Math.max(0, Math.min(800, (event.clientY - bounds.top) * 800 / bounds.height)) };
  };

  return <main style={{ maxWidth: 1320, margin: 'auto', padding: 24 }}>
    <header><h1>Browser</h1><p>{status}</p></header>
    {!session?.authenticated && <p>Sign in to browse through a paired Mac.</p>}
    <form onSubmit={open} style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
      <select aria-label="Paired Mac" value={hostId} onChange={(event) => setHostId(event.target.value)}>
        <option value="">Select a paired Mac</option>
        {hosts.map((host) => <option key={host.id} value={host.id} disabled={!host.online}>{host.name}{host.online ? '' : ' (offline)'}</option>)}
      </select>
      <input aria-label="Web address" type="url" value={url} onChange={(event) => setUrl(event.target.value)} style={{ flex: 1 }} />
      <button type="submit" disabled={!hostId || !session?.csrfToken}>Open</button>
      <button type="button" onClick={() => void revoke()}>Close</button>
    </form>
    {browserLocation && <p style={{ overflowWrap: 'anywhere' }}>{browserLocation}</p>}
    {frame && <img ref={image} src={frame} alt="Live page in isolated HII browser" tabIndex={0}
      style={{ width: '100%', aspectRatio: '8 / 5', objectFit: 'contain', background: '#151515', outline: 'none' }}
      onMouseDown={(event) => { const at = point(event); if (at) send({ t: 'browser.input', event: 'mousePressed', ...at }); }}
      onMouseUp={(event) => { const at = point(event); if (at) send({ t: 'browser.input', event: 'mouseReleased', ...at }); }}
      onMouseMove={(event) => {
        if (Date.now() - lastPointer.current < 32) return;
        lastPointer.current = Date.now();
        const at = point(event); if (at) send({ t: 'browser.input', event: 'mouseMoved', ...at });
      }}
      onWheel={(event) => { event.preventDefault(); const at = point(event); if (at) send({ t: 'browser.input', event: 'mouseWheel', ...at, deltaX: event.deltaX, deltaY: event.deltaY }); }}
      onKeyDown={(event) => { event.preventDefault(); send({ t: 'browser.input', event: 'keyDown', key: event.key, text: event.key.length === 1 ? event.key : '' }); }}
      onKeyUp={(event) => send({ t: 'browser.input', event: 'keyUp', key: event.key })}
    />}
  </main>;
}
