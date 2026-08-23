import { describe, expect, it } from 'vitest';
import {
  decodeSpaceClientMessage,
  decodeSpaceServerMessage,
  encodeSpaceMessage,
  MAX_SPACE_EVENT_FRAME_BYTES,
  MAX_SPACE_SNAPSHOT_FRAME_BYTES,
  type SpaceClientMessage
} from '../../lib/spaces/protocol';
import type { WorkspaceNode } from '../../lib/workspace/types';

function node(): WorkspaceNode {
  return {
    id: 'photo-1',
    spaceId: '14th-street',
    creatorId: 'guest:pending',
    type: 'image',
    x: 10,
    y: 20,
    w: 320,
    h: 240,
    z: 1,
    rotation: 0,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    permissions: { inheritance: 'space-policy' },
    payload: { src: '/api/spaces/14th-street/blobs/photo-1' }
  };
}

describe('Space realtime protocol', () => {
  it('round-trips the four object mutation types', () => {
    const messages: SpaceClientMessage[] = [
      { type: 'object.create', requestId: 'r1', idempotencyKey: 'k1', node: node() },
      { type: 'object.move', requestId: 'r2', idempotencyKey: 'k2', objectId: 'photo-1', patch: { x: 40, y: 50, rotation: 12 } },
      { type: 'object.update', requestId: 'r3', idempotencyKey: 'k3', objectId: 'photo-1', patch: { payload: { src: '/new' } } },
      { type: 'object.delete', requestId: 'r4', idempotencyKey: 'k4', objectId: 'photo-1' }
    ];
    expect(messages.map((message) => decodeSpaceClientMessage(encodeSpaceMessage(message)))).toEqual(messages);
  });

  it('decodes a canonical snapshot and server event', () => {
    const snapshot = decodeSpaceServerMessage(JSON.stringify({
      type: 'space.snapshot',
      spaceId: '14th-street',
      cursor: 4,
      participantId: 'guest:one',
      participants: ['guest:one'],
      workspace: { version: 1, revision: 2, updatedAt: '2026-08-20T00:00:00.000Z', viewport: { x: 0, y: 0, zoom: 1 }, nextZ: 2, nodes: [node()], links: [] }
    }));
    expect(snapshot).toMatchObject({ type: 'space.snapshot', cursor: 4, workspace: { nodes: [{ id: 'photo-1' }] } });

    const event = decodeSpaceServerMessage(JSON.stringify({
      type: 'space.event',
      spaceId: '14th-street',
      cursor: 5,
      event: { type: 'object.move', requestId: 'r2', idempotencyKey: 'k2', objectId: 'photo-1', patch: { x: 40, y: 50 } }
    }));
    expect(event).toMatchObject({ type: 'space.event', cursor: 5, event: { type: 'object.move', objectId: 'photo-1' } });
  });

  it('keeps mutations at 64 KiB while accepting a bounded larger canonical snapshot', () => {
    const large = node();
    large.payload = { text: 'x'.repeat(MAX_SPACE_EVENT_FRAME_BYTES + 1) };
    const encoded = JSON.stringify({
      type: 'space.snapshot', spaceId: '14th-street', cursor: 2,
      participantId: 'guest:one', participants: ['guest:one'],
      workspace: { version: 1, revision: 1, updatedAt: large.updatedAt, viewport: { x: 0, y: 0, zoom: 1 }, nextZ: 2, nodes: [large], links: [] }
    });
    expect(new TextEncoder().encode(encoded).byteLength).toBeGreaterThan(MAX_SPACE_EVENT_FRAME_BYTES);
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(MAX_SPACE_SNAPSHOT_FRAME_BYTES);
    expect(decodeSpaceServerMessage(encoded)).toMatchObject({ type: 'space.snapshot', workspace: { nodes: [{ id: 'photo-1' }] } });
  });

  it('rejects malformed, unknown, prototype-bearing, invalid numeric and oversized frames', () => {
    expect(() => decodeSpaceClientMessage('{')).toThrow(/valid JSON/);
    expect(() => decodeSpaceClientMessage('{"type":"object.delete","requestId":"r","idempotencyKey":"k","objectId":"x","extra":true}')).toThrow(/unknown field/);
    expect(() => decodeSpaceClientMessage('{"type":"presence.heartbeat","__proto__":{}}')).toThrow(/forbidden key/);
    expect(() => decodeSpaceClientMessage(JSON.stringify({ type: 'object.move', requestId: 'r', idempotencyKey: 'k', objectId: 'x', patch: { x: null, y: 0 } }))).toThrow(/numeric range/);
    expect(() => decodeSpaceClientMessage(JSON.stringify({ type: 'presence.heartbeat', pad: 'x'.repeat(MAX_SPACE_EVENT_FRAME_BYTES) }))).toThrow(/too large/);
  });
});
