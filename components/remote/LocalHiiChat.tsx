// SPDX-License-Identifier: LicenseRef-BSL-1.1
'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import styles from '@/components/auth/HiiWebAccess.module.css';

type Host = { id: string; name: string; online: boolean; lastSeenAt: number | null };
type Message = { id: string; role: 'user' | 'assistant'; text: string; state: 'complete' | 'streaming' | 'failed' };

async function hosts(): Promise<Host[]> {
  const response = await fetch('/api/remote/hosts', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error('could_not_read_devices');
  return ((await response.json()) as { hosts?: Host[] }).hosts ?? [];
}

function humanError(value: string) {
  if (value === 'hii_cli_not_installed') return 'This device link needs the HII CLI.';
  if (value === 'hii_is_already_answering') return 'HII is already answering on this device.';
  if (value === 'cancelled') return 'Stopped.';
  return value.replaceAll('_', ' ').slice(0, 240) || 'The local HII run stopped.';
}

export function LocalHiiChat({ onOpenDevices }: { onOpenDevices: () => void }) {
  const [devices, setDevices] = useState<Host[]>([]);
  const [activeHostId, setActiveHostId] = useState('');
  const [connection, setConnection] = useState<'looking' | 'offline' | 'connecting' | 'online'>('looking');
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const socket = useRef<WebSocket | null>(null);
  const end = useRef<HTMLDivElement | null>(null);
  const activeHost = devices.find((host) => host.id === activeHostId) ?? devices.find((host) => host.online) ?? null;

  const refresh = useCallback(async () => {
    try {
      const next = await hosts();
      setDevices(next);
      setActiveHostId((current) => next.some((host) => host.id === current && host.online)
        ? current
        : next.find((host) => host.online)?.id ?? '');
      if (!next.some((host) => host.online)) setConnection('offline');
    } catch {
      setConnection('offline');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!activeHost?.online) return;
    socket.current?.close();
    setConnection('connecting');
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const next = new WebSocket(`${scheme}://${window.location.host}/api/remote/chat?host=${encodeURIComponent(activeHost.id)}`);
    socket.current = next;
    next.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let value: Record<string, unknown>;
      try { value = JSON.parse(event.data); } catch { return; }
      const requestId = typeof value.requestId === 'string' ? value.requestId : '';
      if (value.t === 'chat.room') setConnection(value.hostOnline === true ? 'online' : 'offline');
      if (value.t === 'chat.host-online') setConnection('online');
      if (value.t === 'chat.host-offline') setConnection('offline');
      if (value.t === 'chat.started') setConnection('online');
      if (value.t === 'chat.delta' && requestId && typeof value.text === 'string') {
        setMessages((current) => current.map((message) => message.id === requestId
          ? { ...message, text: message.text + value.text }
          : message));
      }
      if (value.t === 'chat.done' && requestId) {
        setMessages((current) => current.map((message) => message.id === requestId ? { ...message, state: 'complete' } : message));
      }
      if (value.t === 'chat.error' && requestId) {
        const error = humanError(typeof value.error === 'string' ? value.error : 'hii_chat_failed');
        setMessages((current) => current.map((message) => message.id === requestId
          ? { ...message, text: message.text || error, state: 'failed' }
          : message));
      }
    });
    next.addEventListener('open', () => setConnection('connecting'));
    next.addEventListener('close', () => { if (socket.current === next) setConnection('offline'); });
    next.addEventListener('error', () => setConnection('offline'));
    return () => { if (socket.current === next) socket.current = null; next.close(); };
  }, [activeHost?.id, activeHost?.online]);

  useEffect(() => end.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), [messages]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const prompt = draft.trim();
    if (!prompt || connection !== 'online' || socket.current?.readyState !== WebSocket.OPEN) return;
    const requestId = crypto.randomUUID();
    const context = messages
      .filter((message) => message.state === 'complete' && message.text)
      .slice(-10)
      .map(({ role, text }) => ({ role, text }));
    socket.current.send(JSON.stringify({ t: 'chat.run', requestId, prompt, context }));
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: 'user', text: prompt, state: 'complete' },
      { id: requestId, role: 'assistant', text: '', state: 'streaming' },
    ]);
    setDraft('');
  };

  if (!activeHost) {
    return <section className={styles.localChatGate}>
      <h1>Say hi from your own computer.</h1>
      <p>Download and pair HII Chat to unlock this conversation. Its replies run through the HII CLI and model providers available on that computer.</p>
      <button type="button" onClick={onOpenDevices}>download / connect HII Chat</button>
      <small>No paired hardware means no hidden local access and no pretend local answer.</small>
    </section>;
  }

  return <section className={styles.localChat}>
    <header>
      <div><strong>Say hi</strong><small>{activeHost.name} · local HII</small></div>
      <select aria-label="HII chat device" value={activeHost.id} onChange={(event) => setActiveHostId(event.target.value)}>
        {devices.filter((host) => host.online).map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}
      </select>
      <span data-state={connection}>{connection}</span>
    </header>
    <div className={styles.localChatMessages} aria-live="polite">
      {!messages.length ? <p className={styles.localChatEmpty}>Your browser is connected to the HII harness on {activeHost.name}. Ask directly; actions remain governed by HII’s local authority.</p> : null}
      {messages.map((message) => <article key={message.id} data-role={message.role} data-state={message.state}>
        <small>{message.role === 'user' ? 'you' : 'hii'}</small>
        <p>{message.text || (message.state === 'streaming' ? '…' : '')}</p>
      </article>)}
      <div ref={end} />
    </div>
    <form className={styles.localChatComposer} onSubmit={submit}>
      <textarea
        aria-label="Message HII"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={connection === 'online' ? 'Message your HII…' : 'Waiting for your computer…'}
        maxLength={8000}
        enterKeyHint="send"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <button type="submit" disabled={!draft.trim() || connection !== 'online'} aria-label="Send message">↑</button>
    </form>
  </section>;
}
