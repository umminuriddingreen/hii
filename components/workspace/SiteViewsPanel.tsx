'use client';

import { FormEvent, useState } from 'react';

const presets = [
  ['field', '/iterations/field'],
  ['reel', '/iterations/reel'],
  ['atlas', '/iterations/atlas'],
  ['combined', '/iterations/synthesis']
] as const;

export function SiteViewsPanel({ onOpen, onClose }: { onOpen: (url: string) => void; onClose: () => void }) {
  const [base, setBase] = useState('http://127.0.0.1:4173');
  const [url, setUrl] = useState('');
  const open = (value: string) => {
    try { onOpen(new URL(value, `${base.replace(/\/$/, '')}/`).href); } catch { /* invalid input remains editable */ }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); open(url); setUrl(''); };
  return <aside className="hii-site-views-panel" data-workspace-ui aria-label="Website views" onPointerDown={(event) => event.stopPropagation()}>
    <header><div><small>canvas tools</small><strong>Site views</strong></div><button type="button" aria-label="Close site views" onClick={onClose}>×</button></header>
    <label><span>local site</span><input value={base} onChange={(event) => setBase(event.target.value)} inputMode="url" /></label>
    <nav aria-label="Portfolio view presets">{presets.map(([label, path]) => <button type="button" key={label} onClick={() => open(path)}>{label}</button>)}</nav>
    <form onSubmit={submit}><input aria-label="Website view URL" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="route or URL" required /><button type="submit">place view</button></form>
    <small>Each view is a movable browser object. Add several, arrange them, and compare on one canvas.</small>
  </aside>;
}
