import { parseAllowedEmbed, type AllowedEmbedProvider } from './link-embeds';

export type MusicVisibility = 'private' | 'profile' | 'unlisted';

export type PlaylistEntry = {
  id: string;
  provider: AllowedEmbedProvider;
  providerId: string;
  canonicalUrl: string;
  embedUrl: string;
  label: string;
  addedAt: string;
};

export type MusicPlaylist = {
  id: string;
  name: string;
  visibility: MusicVisibility;
  featured: boolean;
  createdAt: string;
  entries: PlaylistEntry[];
};

export type PlaylistProposalChange =
  | { kind: 'add'; playlistId: string; url: string }
  | { kind: 'remove'; playlistId: string; entryId: string }
  | { kind: 'reorder'; playlistId: string; entryIds: string[] }
  | { kind: 'feature'; playlistId: string; featured: boolean }
  | { kind: 'visibility'; playlistId: string; visibility: MusicVisibility }
  | { kind: 'share'; playlistId: string; targetNode: string; visibility: Exclude<MusicVisibility, 'private'> };

export type PlaylistProposal = {
  id: string;
  request: string;
  summary: string;
  createdAt: string;
  changes: PlaylistProposalChange[];
};

export type PlaylistShareHandoff = {
  version: 1;
  targetNode: string;
  visibility: Exclude<MusicVisibility, 'private'>;
  requestedAt: string;
  status: 'pending-agent';
  transport: 'hii-node';
  playlist: {
    name: string;
    featured: boolean;
    entries: Array<Pick<PlaylistEntry, 'provider' | 'providerId' | 'canonicalUrl' | 'label'>>;
  };
  receipt: { required: true; proof: null };
};

export type MusicPanelPayload = {
  surface: 'profile-music';
  version: 1;
  title: string;
  activePlaylistId: string;
  playlists: MusicPlaylist[];
  proposal?: PlaylistProposal;
  curationError?: string;
  share?: PlaylistShareHandoff;
};

function cleanText(value: unknown, max = 120) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
}

function visibility(value: unknown): MusicVisibility {
  return value === 'profile' || value === 'unlisted' ? value : 'private';
}

export function createMusicPanelPayload(now = new Date().toISOString(), id = crypto.randomUUID()): MusicPanelPayload {
  return {
    surface: 'profile-music',
    version: 1,
    title: 'profile music',
    activePlaylistId: id,
    playlists: [{ id, name: 'My playlist', visibility: 'private', featured: false, createdAt: now, entries: [] }]
  };
}

export function normalizeMusicPanelPayload(raw: Record<string, unknown>): MusicPanelPayload {
  const source = Array.isArray(raw.playlists) ? raw.playlists : [];
  const playlists = source.flatMap((value): MusicPlaylist[] => {
    if (!value || typeof value !== 'object') return [];
    const item = value as Record<string, unknown>;
    const id = cleanText(item.id, 64);
    const name = cleanText(item.name, 80);
    if (!id || !name) return [];
    const entries = (Array.isArray(item.entries) ? item.entries : []).flatMap((entry): PlaylistEntry[] => {
      if (!entry || typeof entry !== 'object') return [];
      const candidate = entry as Record<string, unknown>;
      const parsed = parseAllowedEmbed(cleanText(candidate.canonicalUrl, 500));
      const entryId = cleanText(candidate.id, 64);
      if (!parsed || !entryId) return [];
      return [{
        id: entryId,
        provider: parsed.provider,
        providerId: parsed.id,
        canonicalUrl: parsed.canonicalUrl,
        embedUrl: parsed.embedUrl,
        label: cleanText(candidate.label, 140) || parsed.label,
        addedAt: cleanText(candidate.addedAt, 64) || new Date(0).toISOString()
      }];
    }).slice(0, 200);
    return [{
      id,
      name,
      visibility: visibility(item.visibility),
      featured: item.featured === true,
      createdAt: cleanText(item.createdAt, 64) || new Date(0).toISOString(),
      entries
    }];
  }).slice(0, 40);
  if (!playlists.length) return createMusicPanelPayload();
  const active = cleanText(raw.activePlaylistId, 64);
  return {
    surface: 'profile-music',
    version: 1,
    title: 'profile music',
    activePlaylistId: playlists.some((item) => item.id === active) ? active : playlists[0].id,
    playlists,
    proposal: normalizeProposal(raw.proposal, playlists),
    curationError: cleanText(raw.curationError, 300) || undefined,
    share: normalizeShare(raw.share)
  };
}

export function createPlaylist(payload: MusicPanelPayload, name: string, now = new Date().toISOString(), id = crypto.randomUUID()) {
  const cleanName = cleanText(name, 80);
  if (!cleanName) throw new Error('Name the playlist first.');
  if (payload.playlists.some((playlist) => playlist.name.toLowerCase() === cleanName.toLowerCase())) throw new Error('A playlist with that name already exists.');
  return { ...payload, activePlaylistId: id, playlists: [...payload.playlists, { id, name: cleanName, visibility: 'private' as const, featured: false, createdAt: now, entries: [] }] };
}

export function addPlaylistEntry(payload: MusicPanelPayload, playlistId: string, input: string, label = '', now = new Date().toISOString(), id = crypto.randomUUID()) {
  const embed = parseAllowedEmbed(input);
  if (!embed) throw new Error('Use an HTTPS YouTube, Vimeo, or SoundCloud link.');
  const playlist = payload.playlists.find((item) => item.id === playlistId);
  if (!playlist) throw new Error('Choose a playlist first.');
  if (playlist.entries.some((entry) => entry.provider === embed.provider && entry.providerId === embed.id)) throw new Error('That item is already in this playlist.');
  const entry: PlaylistEntry = { id, provider: embed.provider, providerId: embed.id, canonicalUrl: embed.canonicalUrl, embedUrl: embed.embedUrl, label: cleanText(label, 140) || embed.label, addedAt: now };
  return { ...payload, playlists: payload.playlists.map((item) => item.id === playlistId ? { ...item, entries: [...item.entries, entry] } : item) };
}

export function updatePlaylist(payload: MusicPanelPayload, playlistId: string, patch: Partial<Pick<MusicPlaylist, 'visibility' | 'featured'>>) {
  return { ...payload, playlists: payload.playlists.map((playlist) => playlist.id === playlistId ? { ...playlist, ...patch } : playlist) };
}

export function removePlaylistEntry(payload: MusicPanelPayload, playlistId: string, entryId: string) {
  return { ...payload, playlists: payload.playlists.map((playlist) => playlist.id === playlistId ? { ...playlist, entries: playlist.entries.filter((entry) => entry.id !== entryId) } : playlist) };
}

export function movePlaylistEntry(payload: MusicPanelPayload, playlistId: string, entryId: string, delta: -1 | 1) {
  return { ...payload, playlists: payload.playlists.map((playlist) => {
    if (playlist.id !== playlistId) return playlist;
    const entries = [...playlist.entries];
    const from = entries.findIndex((entry) => entry.id === entryId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= entries.length) return playlist;
    [entries[from], entries[to]] = [entries[to], entries[from]];
    return { ...playlist, entries };
  }) };
}

export function buildPlaylistShareHandoff(payload: MusicPanelPayload, playlistId: string, targetNode: string, shareVisibility: Exclude<MusicVisibility, 'private'>, now = new Date().toISOString()): PlaylistShareHandoff {
  const playlist = payload.playlists.find((item) => item.id === playlistId);
  const target = cleanText(targetNode, 120);
  if (!playlist) throw new Error('Choose a playlist first.');
  if (!target) throw new Error('Name the target HII node.');
  return {
    version: 1,
    targetNode: target,
    visibility: shareVisibility,
    requestedAt: now,
    status: 'pending-agent',
    transport: 'hii-node',
    playlist: {
      name: playlist.name,
      featured: playlist.featured,
      entries: playlist.entries.map(({ provider, providerId, canonicalUrl, label }) => ({ provider, providerId, canonicalUrl, label }))
    },
    receipt: { required: true, proof: null }
  };
}

export function buildCurationAgentPrompt(request: string, payload: MusicPanelPayload) {
  const compact = payload.playlists.map((playlist) => ({
    id: playlist.id,
    name: playlist.name,
    visibility: playlist.visibility,
    featured: playlist.featured,
    entries: playlist.entries.map((entry) => ({ id: entry.id, provider: entry.provider, url: entry.canonicalUrl }))
  }));
  return [
    'You are proposing edits to an HII music profile. Do not apply or publish anything.',
    'Return JSON only with: {"summary":"...","changes":[...]}.',
    'Allowed changes: add {kind,playlistId,url}; remove {kind,playlistId,entryId}; reorder {kind,playlistId,entryIds}; feature {kind,playlistId,featured}; visibility {kind,playlistId,visibility}; share {kind,playlistId,targetNode,visibility}.',
    'Only HTTPS YouTube, Vimeo, or SoundCloud URLs are allowed. Sharing is a metadata-only proposal and still requires confirmation.',
    `Request: ${cleanText(request, 500)}`,
    `Current playlists: ${JSON.stringify(compact)}`
  ].join('\n');
}

function extractJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(candidate);
}

export function parseCurationProposal(text: string, request: string, payload: MusicPanelPayload, now = new Date().toISOString(), id = crypto.randomUUID()): PlaylistProposal {
  const raw = extractJson(text) as Record<string, unknown>;
  const proposal = normalizeProposal({ ...raw, request, createdAt: now, id }, payload.playlists);
  if (!proposal || !proposal.changes.length) throw new Error('HII did not return a valid playlist proposal. Nothing changed.');
  return proposal;
}

function normalizeProposal(raw: unknown, playlists: MusicPlaylist[]): PlaylistProposal | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const known = new Map(playlists.map((playlist) => [playlist.id, playlist]));
  const changes = (Array.isArray(value.changes) ? value.changes : []).flatMap((item): PlaylistProposalChange[] => {
    if (!item || typeof item !== 'object') return [];
    const change = item as Record<string, unknown>;
    const kind = cleanText(change.kind, 20);
    const playlistId = cleanText(change.playlistId, 64);
    const playlist = known.get(playlistId);
    if (!playlist) return [];
    if (kind === 'add') {
      const parsed = parseAllowedEmbed(cleanText(change.url, 500));
      return parsed ? [{ kind, playlistId, url: parsed.canonicalUrl }] : [];
    }
    if (kind === 'remove') {
      const entryId = cleanText(change.entryId, 64);
      return playlist.entries.some((entry) => entry.id === entryId) ? [{ kind, playlistId, entryId }] : [];
    }
    if (kind === 'reorder' && Array.isArray(change.entryIds)) {
      const entryIds = change.entryIds.map((entry) => cleanText(entry, 64)).filter(Boolean);
      return entryIds.length === playlist.entries.length && new Set(entryIds).size === entryIds.length && entryIds.every((entry) => playlist.entries.some((candidate) => candidate.id === entry)) ? [{ kind, playlistId, entryIds }] : [];
    }
    if (kind === 'feature' && typeof change.featured === 'boolean') return [{ kind, playlistId, featured: change.featured }];
    if (kind === 'visibility' && ['private', 'profile', 'unlisted'].includes(String(change.visibility))) return [{ kind, playlistId, visibility: change.visibility as MusicVisibility }];
    if (kind === 'share' && ['profile', 'unlisted'].includes(String(change.visibility))) {
      const targetNode = cleanText(change.targetNode, 120);
      return targetNode ? [{ kind, playlistId, targetNode, visibility: change.visibility as Exclude<MusicVisibility, 'private'> }] : [];
    }
    return [];
  }).slice(0, 50);
  const proposalId = cleanText(value.id, 64);
  const summary = cleanText(value.summary, 300);
  if (!proposalId || !summary || !changes.length) return undefined;
  return { id: proposalId, request: cleanText(value.request, 500), summary, createdAt: cleanText(value.createdAt, 64) || new Date(0).toISOString(), changes };
}

export function applyCurationProposal(payload: MusicPanelPayload, proposal: PlaylistProposal, now = new Date().toISOString(), idFactory: () => string = () => crypto.randomUUID()) {
  let next: MusicPanelPayload = { ...payload, proposal: undefined, curationError: undefined };
  for (const change of proposal.changes) {
    if (change.kind === 'add') next = addPlaylistEntry(next, change.playlistId, change.url, '', now, idFactory());
    if (change.kind === 'remove') next = removePlaylistEntry(next, change.playlistId, change.entryId);
    if (change.kind === 'reorder') next = { ...next, playlists: next.playlists.map((playlist) => playlist.id === change.playlistId ? { ...playlist, entries: change.entryIds.map((entryId) => playlist.entries.find((entry) => entry.id === entryId)!).filter(Boolean) } : playlist) };
    if (change.kind === 'feature') next = updatePlaylist(next, change.playlistId, { featured: change.featured });
    if (change.kind === 'visibility') next = updatePlaylist(next, change.playlistId, { visibility: change.visibility });
    if (change.kind === 'share') next = { ...next, share: buildPlaylistShareHandoff(next, change.playlistId, change.targetNode, change.visibility, now) };
  }
  return next;
}

function normalizeShare(raw: unknown): PlaylistShareHandoff | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const targetNode = cleanText(value.targetNode, 120);
  const shareVisibility = value.visibility === 'profile' ? 'profile' : value.visibility === 'unlisted' ? 'unlisted' : null;
  const playlist = value.playlist && typeof value.playlist === 'object' ? value.playlist as Record<string, unknown> : null;
  if (!targetNode || !shareVisibility || !playlist) return undefined;
  const entries = (Array.isArray(playlist.entries) ? playlist.entries : []).flatMap((entry): PlaylistShareHandoff['playlist']['entries'] => {
    if (!entry || typeof entry !== 'object') return [];
    const candidate = entry as Record<string, unknown>;
    const parsed = parseAllowedEmbed(cleanText(candidate.canonicalUrl, 500));
    return parsed ? [{ provider: parsed.provider, providerId: parsed.id, canonicalUrl: parsed.canonicalUrl, label: cleanText(candidate.label, 140) || parsed.label }] : [];
  });
  return {
    version: 1,
    targetNode,
    visibility: shareVisibility,
    requestedAt: cleanText(value.requestedAt, 64) || new Date(0).toISOString(),
    status: 'pending-agent',
    transport: 'hii-node',
    playlist: { name: cleanText(playlist.name, 80), featured: playlist.featured === true, entries },
    receipt: { required: true, proof: null }
  };
}
