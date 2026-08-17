'use client';

import { useMemo, useState } from 'react';
import {
  addPlaylistEntry,
  applyCurationProposal,
  buildPlaylistShareHandoff,
  createPlaylist,
  movePlaylistEntry,
  normalizeMusicPanelPayload,
  removePlaylistEntry,
  updatePlaylist,
  type MusicPanelPayload,
  type MusicVisibility
} from '@/lib/workspace/music-playlists';

type Props = {
  payload: Record<string, unknown>;
  onPayload: (payload: MusicPanelPayload) => void;
  onRequestCuration: (request: string, payload: MusicPanelPayload) => void;
};

function proposalLabel(change: NonNullable<MusicPanelPayload['proposal']>['changes'][number]) {
  if (change.kind === 'add') return `Add ${change.url}`;
  if (change.kind === 'remove') return `Remove ${change.entryId}`;
  if (change.kind === 'reorder') return `Reorder ${change.entryIds.length} items`;
  if (change.kind === 'feature') return change.featured ? 'Feature on profile' : 'Remove from featured';
  if (change.kind === 'visibility') return `Set visibility to ${change.visibility}`;
  return `Prepare ${change.visibility} share for ${change.targetNode}`;
}

export function MusicPlaylistPanel({ payload: raw, onPayload, onRequestCuration }: Props) {
  const payload = useMemo(() => normalizeMusicPanelPayload(raw), [raw]);
  const active = payload.playlists.find((playlist) => playlist.id === payload.activePlaylistId) || payload.playlists[0];
  const [newName, setNewName] = useState('');
  const [link, setLink] = useState('');
  const [linkLabel, setLinkLabel] = useState('');
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState<string | null>(null);
  const [curation, setCuration] = useState('');
  const [targetNode, setTargetNode] = useState('');
  const [shareVisibility, setShareVisibility] = useState<Exclude<MusicVisibility, 'private'>>('unlisted');

  const commit = (next: MusicPanelPayload) => {
    setError('');
    onPayload(next);
  };

  const prepareShare = () => {
    try {
      commit({ ...payload, share: buildPlaylistShareHandoff(payload, active.id, targetNode, shareVisibility) });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const downloadHandoff = () => {
    if (!payload.share) return;
    const blob = new Blob([`${JSON.stringify(payload.share, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `hii-playlist-${active.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'handoff'}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <article className="hii-music-panel">
      <header className="hii-music-head">
        <div><span>HII PROFILE / MUSIC</span><strong>v1</strong></div>
        <small>{active.featured ? 'featured · ' : ''}{active.visibility} · local</small>
      </header>

      <div className="hii-music-scroll">
        <section className="hii-music-playlist-bar" aria-label="Playlist selection">
          <label>
            <span>playlist</span>
            <select value={active.id} onChange={(event) => commit({ ...payload, activePlaylistId: event.target.value })}>
              {payload.playlists.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.name} · {playlist.entries.length}</option>)}
            </select>
          </label>
          <form onSubmit={(event) => {
            event.preventDefault();
            try {
              commit(createPlaylist(payload, newName));
              setNewName('');
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : String(caught));
            }
          }}>
            <input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="New playlist name" aria-label="New playlist name" />
            <button type="submit">Create</button>
          </form>
        </section>

        <section className="hii-music-profile-controls" aria-label="Profile curation">
          <label><span>visibility</span><select value={active.visibility} onChange={(event) => commit(updatePlaylist(payload, active.id, { visibility: event.target.value as MusicVisibility }))}><option value="private">Private</option><option value="profile">Profile</option><option value="unlisted">Unlisted</option></select></label>
          <label className="hii-music-check"><input type="checkbox" checked={active.featured} onChange={(event) => commit(updatePlaylist(payload, active.id, { featured: event.target.checked }))} /><span>Feature on HII profile</span></label>
        </section>

        <section className="hii-music-add">
          <form onSubmit={(event) => {
            event.preventDefault();
            try {
              commit(addPlaylistEntry(payload, active.id, link, linkLabel));
              setLink('');
              setLinkLabel('');
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : String(caught));
            }
          }}>
            <label htmlFor={`music-link-${active.id}`}>Add a music component</label>
            <div><input id={`music-link-${active.id}`} value={link} onChange={(event) => setLink(event.target.value)} placeholder="Paste a YouTube, Vimeo, or SoundCloud link" inputMode="url" /><input value={linkLabel} onChange={(event) => setLinkLabel(event.target.value)} placeholder="Optional track title" aria-label="Track title" /><button type="submit">Add</button></div>
          </form>
          <p>HII stores the public link and provider ID only. Play connects directly to the named provider; no media is downloaded.</p>
        </section>

        {error && <output className="hii-music-error" aria-live="polite">{error}</output>}

        <ol className="hii-music-tracks" aria-label={`${active.name} items`}>
          {active.entries.map((entry, index) => (
            <li key={entry.id} data-playing={playing === entry.id || undefined}>
              <div className="hii-music-track-index">{String(index + 1).padStart(2, '0')}</div>
              <div className="hii-music-track-copy"><strong>{entry.label}</strong><span>{entry.provider} · {entry.providerId}</span></div>
              <div className="hii-music-track-actions">
                <button type="button" onClick={() => setPlaying((current) => current === entry.id ? null : entry.id)}>{playing === entry.id ? 'Close' : 'Play'}</button>
                <button type="button" aria-label={`Move ${entry.label} up`} disabled={index === 0} onClick={() => commit(movePlaylistEntry(payload, active.id, entry.id, -1))}>↑</button>
                <button type="button" aria-label={`Move ${entry.label} down`} disabled={index === active.entries.length - 1} onClick={() => commit(movePlaylistEntry(payload, active.id, entry.id, 1))}>↓</button>
                <button type="button" onClick={() => { setPlaying(null); commit(removePlaylistEntry(payload, active.id, entry.id)); }}>Remove</button>
              </div>
              {playing === entry.id && (
                <div className="hii-music-embed">
                  <iframe
                    src={entry.embedUrl}
                    title={`${entry.provider} player for ${entry.label}`}
                    loading="lazy"
                    allow="autoplay; encrypted-media; picture-in-picture"
                    sandbox="allow-scripts allow-same-origin allow-presentation"
                    referrerPolicy="strict-origin-when-cross-origin"
                    allowFullScreen
                  />
                  <a href={entry.canonicalUrl} target="_blank" rel="noreferrer">Open public source ↗</a>
                </div>
              )}
            </li>
          ))}
          {!active.entries.length && <li className="hii-music-empty"><strong>Your taste, arranged by you.</strong><span>Add a public link to begin this personal era archive.</span></li>}
        </ol>

        <section className="hii-music-agent">
          <header><strong>Curate with HII</strong><span>proposal only</span></header>
          <form onSubmit={(event) => { event.preventDefault(); if (curation.trim()) { onRequestCuration(curation.trim(), payload); setCuration(''); } }}>
            <textarea value={curation} onChange={(event) => setCuration(event.target.value)} placeholder="Move the two quiet tracks first, then feature this playlist…" aria-label="Curation request" />
            <button type="submit">Preview proposal</button>
          </form>
          <p>The existing HII agent may propose add, remove, reorder, feature, visibility, or share changes. Nothing changes until you confirm.</p>
          {payload.curationError && <output className="hii-music-error">{payload.curationError}</output>}
          {payload.proposal && (
            <div className="hii-music-proposal">
              <strong>{payload.proposal.summary}</strong>
              <ul>{payload.proposal.changes.map((change, index) => <li key={`${change.kind}:${index}`}>{proposalLabel(change)}</li>)}</ul>
              <div><button type="button" onClick={() => commit(applyCurationProposal(payload, payload.proposal!))}>Confirm changes</button><button type="button" onClick={() => commit({ ...payload, proposal: undefined })}>Dismiss</button></div>
            </div>
          )}
        </section>

        <section className="hii-music-share">
          <header><strong>HII node handoff</strong><span>not sent</span></header>
          <div><input value={targetNode} onChange={(event) => setTargetNode(event.target.value)} placeholder="Target node ID" aria-label="Target HII node" /><select value={shareVisibility} onChange={(event) => setShareVisibility(event.target.value as Exclude<MusicVisibility, 'private'>)}><option value="unlisted">Unlisted</option><option value="profile">Profile</option></select><button type="button" onClick={prepareShare}>Prepare share</button></div>
          <p>Current HII node transport has no wired executor. Preparing creates a metadata-only handoff; it does not claim a remote send.</p>
          {payload.share && (
            <div className="hii-music-share-state">
              <span>target <b>{payload.share.targetNode}</b></span><span>state <b>{payload.share.status}</b></span><span>proof <b>required · unavailable</b></span>
              <button type="button" onClick={downloadHandoff}>Download handoff JSON</button>
            </div>
          )}
        </section>
      </div>
    </article>
  );
}
