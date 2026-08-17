import { describe, expect, it } from 'vitest';
import {
  addPlaylistEntry,
  applyCurationProposal,
  buildCurationAgentPrompt,
  buildPlaylistShareHandoff,
  createMusicPanelPayload,
  createPlaylist,
  parseCurationProposal
} from '../../lib/workspace/music-playlists';

const NOW = '2026-08-16T12:00:00.000Z';

describe('HII profile music playlists', () => {
  it('creates, selects, and deduplicates canonical entries', () => {
    const initial = createMusicPanelPayload(NOW, 'playlist-a');
    const withSecond = createPlaylist(initial, 'Reference set', NOW, 'playlist-b');
    expect(withSecond.activePlaylistId).toBe('playlist-b');
    const added = addPlaylistEntry(withSecond, 'playlist-b', 'https://youtu.be/dQw4w9WgXcQ?t=4', 'A human title', NOW, 'entry-a');
    expect(added.playlists[1].entries[0]).toMatchObject({
      provider: 'youtube',
      providerId: 'dQw4w9WgXcQ',
      canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      label: 'A human title'
    });
    expect(() => addPlaylistEntry(added, 'playlist-b', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toThrow(/already/);
  });

  it('prepares a truthful metadata-only node handoff', () => {
    const added = addPlaylistEntry(createMusicPanelPayload(NOW, 'playlist-a'), 'playlist-a', 'https://youtu.be/dQw4w9WgXcQ', '', NOW, 'entry-a');
    const handoff = buildPlaylistShareHandoff(added, 'playlist-a', 'living-room-node', 'unlisted', NOW);
    expect(handoff).toMatchObject({
      targetNode: 'living-room-node',
      status: 'pending-agent',
      transport: 'hii-node',
      receipt: { required: true, proof: null }
    });
    const serialized = JSON.stringify(handoff);
    expect(serialized).toContain('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(serialized).not.toMatch(/cookie|token|localPath|mediaBytes|\/Users\//i);
  });

  it('keeps agent curation proposal-only until explicit application', () => {
    const initial = createMusicPanelPayload(NOW, 'playlist-a');
    const response = JSON.stringify({
      summary: 'Add one reference and feature the playlist.',
      changes: [
        { kind: 'add', playlistId: 'playlist-a', url: 'https://youtu.be/dQw4w9WgXcQ' },
        { kind: 'feature', playlistId: 'playlist-a', featured: true }
      ]
    });
    const proposal = parseCurationProposal(response, 'Feature this', initial, NOW, 'proposal-a');
    expect(initial.playlists[0].entries).toHaveLength(0);
    expect(initial.playlists[0].featured).toBe(false);
    const applied = applyCurationProposal(initial, proposal, NOW, () => 'entry-a');
    expect(applied.playlists[0].entries).toHaveLength(1);
    expect(applied.playlists[0].featured).toBe(true);
  });

  it('gives the existing HII agent a bounded proposal contract', () => {
    const prompt = buildCurationAgentPrompt('Move the calm tracks first', createMusicPanelPayload(NOW, 'playlist-a'));
    expect(prompt).toContain('Do not apply or publish anything');
    expect(prompt).toContain('Return JSON only');
    expect(prompt).toContain('metadata-only proposal');
  });
});
