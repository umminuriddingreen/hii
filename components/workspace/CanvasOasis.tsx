'use client';

import { useState, type FormEvent } from 'react';
import styles from './CanvasOasis.module.css';

export type OasisTarget = { id: string; title: string; count?: number };

type Props = {
  empty: boolean;
  recent: OasisTarget[];
  spaces: OasisTarget[];
  onCommand: () => void;
  onNote: () => void;
  onFile: (imagesOnly: boolean) => void;
  onLink: (url: string) => void;
  onFocus: (id: string) => void;
  onFit: () => void;
};

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning.' : hour < 17 ? 'Good afternoon.' : 'Good evening.';
}

export function CanvasOasis({ empty, recent, spaces, onCommand, onNote, onFile, onLink, onFocus, onFit }: Props) {
  const [open, setOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState<string | null>(null);
  const [linkError, setLinkError] = useState('');

  const addLink = (event: FormEvent) => {
    event.preventDefault();
    try {
      const url = new URL(linkDraft?.trim() || '');
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an http or https link.');
      onLink(url.toString());
      setLinkDraft(null);
      setLinkError('');
    } catch {
      setLinkError('Enter a complete web link.');
    }
  };

  if (!empty && !open) return <button type="button" className={styles.overviewTrigger} data-workspace-ui onClick={() => setOpen(true)}>Overview</button>;

  return <section className={empty ? styles.empty : styles.overview} data-workspace-ui aria-label={empty ? 'Start on your canvas' : 'Canvas overview'}>
    {!empty && <header className={styles.header}>
      <strong>Your canvas</strong>
      <button type="button" onClick={() => setOpen(false)} aria-label="Close overview">×</button>
    </header>}
    {empty && <>
      <span className={styles.wordmark}>hii</span>
      <h1>{greeting()}</h1>
      <p>What are you working on?</p>
      <p className={styles.gestureHint}>Double tap to write · Triple tap to add</p>
    </>}
    <button type="button" className={styles.command} onClick={onCommand}>Ask or do anything <span aria-hidden="true">↗</span></button>
    {recent.length > 0 && <div className={styles.section}>
      <h2>Recent</h2>
      {recent.map((item) => <button type="button" key={item.id} onClick={() => { onFocus(item.id); setOpen(false); }}>{item.title}</button>)}
    </div>}
    {spaces.length > 0 && <div className={styles.section}>
      <h2>Spaces</h2>
      {spaces.map((item) => <button type="button" key={item.id} onClick={() => { onFocus(item.id); setOpen(false); }}>{item.title}<small>{item.count} objects</small></button>)}
      {!empty && <button type="button" onClick={() => { onFit(); setOpen(false); }}>See everything</button>}
    </div>}
    <div className={styles.capture} aria-label="Add to canvas">
      <span>Drop anything here, or add</span>
      <div>
        <button type="button" onClick={onNote}>Note</button>
        <button type="button" onClick={() => { setLinkDraft(''); setLinkError(''); }}>Link</button>
        <button type="button" onClick={() => onFile(false)}>File</button>
        <button type="button" onClick={() => onFile(true)}>Image</button>
      </div>
    </div>
    {linkDraft !== null && <form className={styles.linkForm} onSubmit={addLink}>
      <input autoFocus aria-label="Web link" type="url" value={linkDraft} placeholder="https://" onChange={(event) => setLinkDraft(event.target.value)} />
      <button type="submit">Add</button>
      <button type="button" onClick={() => setLinkDraft(null)}>Cancel</button>
      {linkError && <small role="alert">{linkError}</small>}
    </form>}
  </section>;
}
