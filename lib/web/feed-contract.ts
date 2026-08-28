// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { canvasTextSeed, seedFor, type NodeSeed } from '@/lib/workspace/ingest';
import { INK_DEFAULT_COLOR, readStrokes, strokeBounds, type InkStroke } from '@/lib/workspace/ink';
import type { SpatialObjectMetadata, WorkspaceNode } from '@/lib/workspace/types';

export type FeedSnapshot =
  | { kind: 'text'; text: string }
  | { kind: 'sticker'; emoji: string }
  | { kind: 'ink'; strokes: InkStroke[] };

export type FeedItem = {
  id: string;
  authorHandle: string;
  snapshot: FeedSnapshot;
  provenance: {
    source: string;
    assurance: 'session-authenticated-account-asserted';
    sourceUpdatedAt: string;
    sharedAt: number;
    contentHash: string;
  };
  createdAt: number;
  ownedByViewer: boolean;
};

function feedProvenance(item: FeedItem) {
  return {
    feedItemId: item.id,
    authorHandle: item.authorHandle,
    source: item.provenance.source,
    assurance: item.provenance.assurance,
    sourceUpdatedAt: item.provenance.sourceUpdatedAt,
    sharedAt: item.provenance.sharedAt,
    contentHash: item.provenance.contentHash,
  };
}

function feedObject(item: FeedItem, kind: 'note' | 'asset'): SpatialObjectMetadata {
  return {
    kind,
    owner: `account:${item.authorHandle}`,
    status: 'unknown',
    source: `HII feed ${item.id} · ${item.provenance.assurance}`,
    audit: [{
      ts: new Date(item.createdAt).toISOString(),
      actor: 'hii',
      action: 'imported account-asserted HII feed item',
      note: `content integrity ${item.provenance.contentHash}`,
    }],
  };
}

const MAX_TEXT = 4_000;
const MAX_STROKES = 32;
const MAX_POINTS = 8_000;

function safeText(value: unknown, limit: number) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, limit);
}

function safeInk(raw: unknown): InkStroke[] {
  let totalPoints = 0;
  return readStrokes(raw).slice(0, MAX_STROKES).flatMap((stroke) => {
    const remaining = MAX_POINTS - totalPoints;
    if (remaining < 2) return [];
    const points = stroke.points.slice(0, remaining * 2);
    totalPoints += Math.floor(points.length / 2);
    if (points.length < 4) return [];
    return [{ points, color: INK_DEFAULT_COLOR, width: Math.min(12, Math.max(1, stroke.width)) }];
  });
}

export function feedSnapshotFromNode(node: WorkspaceNode): FeedSnapshot | null {
  // Imported feed items are attributed account assertions, not fresh primary
  // sources. Refuse to launder them through a new share until the server owns
  // and verifies an explicit derivation chain.
  if ('feedProvenance' in node.payload) return null;
  if (node.type === 'canvas-text') {
    const text = safeText(node.payload.text, MAX_TEXT);
    return text ? { kind: 'text', text } : null;
  }
  if (node.type === 'image' && node.payload.sticker === true) {
    const emoji = safeText(node.payload.emoji, 16);
    return emoji ? { kind: 'sticker', emoji } : null;
  }
  if (node.type === 'ink') {
    const strokes = safeInk(node.payload.strokes);
    return strokes.length ? { kind: 'ink', strokes } : null;
  }
  return null;
}

export function nodeSeedFromFeedSnapshot(item: FeedItem): NodeSeed {
  if (item.snapshot.kind === 'text') {
    const seed = canvasTextSeed(item.snapshot.text);
    return {
      ...seed,
      payload: { ...seed.payload, feedProvenance: feedProvenance(item) },
      object: feedObject(item, 'note'),
    };
  }
  if (item.snapshot.kind === 'sticker') {
    return {
      ...seedFor('image', { sticker: true, emoji: item.snapshot.emoji, name: 'Shared sticker', feedProvenance: feedProvenance(item) }),
      w: 120,
      h: 120,
      object: feedObject(item, 'asset'),
    };
  }
  const strokes = safeInk(item.snapshot.strokes);
  const bounds = strokeBounds(strokes);
  return {
    ...seedFor('ink', { strokes, name: 'Shared drawing', feedProvenance: feedProvenance(item) }),
    w: Math.max(40, Math.min(720, bounds?.w ?? 140)),
    h: Math.max(40, Math.min(720, bounds?.h ?? 80)),
    object: feedObject(item, 'asset'),
  };
}
