'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import styles from './quick-capture.module.css';

export default function QuickCapturePage() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const pending = useRef<string | null>(null);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const prefill = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const clipboard = await invoke<string>('quick_capture_clipboard');
      setText(clipboard);
    } catch {
      setText('');
    }
    setError('');
    requestAnimationFrame(() => input.current?.focus());
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    void prefill();
    let listeners: (() => void)[] = [];
    const clearPending = () => {
      pending.current = null;
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
      pendingTimer.current = null;
      setBusy(false);
    };
    void Promise.all([
      listen('hii:quick-capture:open', () => void prefill()),
      listen<{ captureId: string; nodeId: string }>('hii:quick-capture-saved', (event) => {
        if (event.payload.captureId !== pending.current) return;
        clearPending();
        setText('');
        void invoke('quick_capture_hide');
      }),
      listen<{ captureId: string; error: string }>('hii:quick-capture-failed', (event) => {
        if (event.payload.captureId !== pending.current) return;
        clearPending();
        setError(event.payload.error || 'Could not save this capture.');
      }),
    ]).then((dispose) => { listeners = dispose; });
    return () => { listeners.forEach((dispose) => dispose()); if (pendingTimer.current) clearTimeout(pendingTimer.current); };
  }, [prefill]);

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || !text.trim()) return;
    setBusy(true);
    setError('');
    const captureId = crypto.randomUUID();
    pending.current = captureId;
    try {
      await invoke('quick_capture_save', { text, captureId });
      if (pending.current !== captureId) return;
      pendingTimer.current = setTimeout(() => {
        if (pending.current !== captureId) return;
        pending.current = null;
        setBusy(false);
        setError('HII has not confirmed this capture. Keep this window open and retry.');
      }, 15_000);
    } catch (cause) {
      pending.current = null;
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void invoke('quick_capture_hide');
      } else if (event.key === 'Enter' && event.metaKey) {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  if (!isTauri()) return <main className={styles.unavailable}>Quick capture opens from the HII desktop app with ⌃⌥H.</main>;

  return (
    <main className={styles.frame}>
      <form className={styles.panel} onSubmit={save}>
        <div className={styles.topline}>
          <span className={styles.mark}>hii</span>
          <span className={styles.label}>Quick capture</span>
          <button className={styles.open} type="button" onClick={() => void invoke('quick_capture_open_main')}>Open HII ↗</button>
        </div>
        <textarea
          ref={input}
          className={styles.input}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Capture an idea, link, or anything you need to return to…"
          aria-label="Quick capture content"
          rows={4}
          maxLength={100_000}
        />
        <div className={styles.bottomline}>
          <span className={styles.hint}>{error || 'Saved to your current HII Space'}</span>
          <button className={styles.save} type="submit" disabled={busy || !text.trim()}>{busy ? 'Saving…' : 'Save  ⌘↵'}</button>
        </div>
      </form>
    </main>
  );
}
