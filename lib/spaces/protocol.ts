import {
  normalizeNode,
  normalizeWorkspace,
  spaceObjectNodeTypes,
  type WorkspaceDoc,
  type WorkspaceNode
} from '../workspace/types.ts';

export const SPACE_EVENTS_PATH_SUFFIX = '/events';
export const MAX_SPACE_EVENT_FRAME_BYTES = 64 * 1024;
/** Canonical snapshots are larger than mutations but remain resource-bounded. */
export const MAX_SPACE_SNAPSHOT_FRAME_BYTES = 8 * 1024 * 1024;
export const SPACE_PRESENCE_HEARTBEAT_MS = 15_000;
export const SPACE_PRESENCE_TIMEOUT_MS = 45_000;

export type SpaceMovePatch = Pick<WorkspaceNode, 'x' | 'y'> &
  Partial<Pick<WorkspaceNode, 'w' | 'h' | 'z' | 'rotation'>>;

export type SpaceUpdatePatch = Partial<
  Pick<WorkspaceNode, 'type' | 'payload' | 'object' | 'objectRef' | 'frameId' | 'permissions'>
>;

type MutationEnvelope = {
  requestId: string;
  idempotencyKey: string;
};

export type SpaceObjectMutation =
  | (MutationEnvelope & { type: 'object.create'; node: WorkspaceNode })
  | (MutationEnvelope & { type: 'object.move'; objectId: string; patch: SpaceMovePatch })
  | (MutationEnvelope & { type: 'object.update'; objectId: string; patch: SpaceUpdatePatch })
  | (MutationEnvelope & { type: 'object.delete'; objectId: string });

export type SpaceClientMessage =
  | SpaceObjectMutation
  | { type: 'presence.heartbeat' };

export type SpaceSnapshotMessage = {
  type: 'space.snapshot';
  spaceId: string;
  cursor: number;
  participantId: string;
  participants: string[];
  workspace: WorkspaceDoc;
};

export type SpaceServerMessage =
  | SpaceSnapshotMessage
  | { type: 'space.event'; spaceId: string; cursor: number; event: SpaceObjectMutation }
  | { type: 'space.ack'; requestId: string; cursor: number; replayed: boolean }
  | { type: 'space.error'; requestId?: string; code: string; message: string; retryable: boolean }
  | { type: 'presence.join'; participantId: string }
  | { type: 'presence.leave'; participantId: string }
  | { type: 'presence.heartbeat'; at: string };

const objectTypes = new Set<string>(Object.values(spaceObjectNodeTypes));
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);

function fail(message: string): never {
  throw new TypeError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertSafeJson(value: unknown, depth = 0): void {
  if (depth > 12) fail('Space event nesting is too deep.');
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  if (Array.isArray(value)) {
    if (value.length > 1_000) fail('Space event array is too large.');
    for (const item of value) assertSafeJson(item, depth + 1);
    return;
  }
  if (!isRecord(value)) fail('Space event contains a non-JSON value.');
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) fail(`Space event contains forbidden key ${key}.`);
    assertSafeJson(item, depth + 1);
  }
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) fail('Space event contains an unknown field.');
}

function text(value: unknown, field: string, max = 160): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    fail(`${field} must be a non-empty string no longer than ${max} characters.`);
  }
  return value;
}

function finite(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(`${field} is outside the accepted numeric range.`);
  }
  return value;
}

function parseJsonFrame(raw: string, maxBytes = MAX_SPACE_EVENT_FRAME_BYTES): Record<string, unknown> {
  if (new TextEncoder().encode(raw).byteLength > maxBytes) fail('Space event frame is too large.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('Space event must be valid JSON.');
  }
  assertSafeJson(parsed);
  if (!isRecord(parsed)) fail('Space event must be a JSON object.');
  return parsed;
}

function mutationEnvelope(value: Record<string, unknown>) {
  return {
    requestId: text(value.requestId, 'requestId', 100),
    idempotencyKey: text(value.idempotencyKey, 'idempotencyKey', 160)
  };
}

function parseObjectId(value: unknown): string {
  return text(value, 'objectId', 64);
}

function parseMovePatch(value: unknown): SpaceMovePatch {
  if (!isRecord(value)) fail('object.move patch must be an object.');
  exactKeys(value, ['x', 'y', 'w', 'h', 'z', 'rotation']);
  const patch: SpaceMovePatch = {
    x: finite(value.x, 'patch.x', -10_000_000, 10_000_000),
    y: finite(value.y, 'patch.y', -10_000_000, 10_000_000)
  };
  if (value.w !== undefined) patch.w = finite(value.w, 'patch.w', 40, 10_000);
  if (value.h !== undefined) patch.h = finite(value.h, 'patch.h', 40, 10_000);
  if (value.z !== undefined) patch.z = finite(value.z, 'patch.z', 0, 10_000_000);
  if (value.rotation !== undefined) patch.rotation = finite(value.rotation, 'patch.rotation', -360_000, 360_000);
  return patch;
}

function parseUpdatePatch(value: unknown): SpaceUpdatePatch {
  if (!isRecord(value)) fail('object.update patch must be an object.');
  exactKeys(value, ['type', 'payload', 'object', 'objectRef', 'frameId', 'permissions']);
  if (value.type !== undefined && (typeof value.type !== 'string' || !objectTypes.has(value.type))) {
    fail('object.update type is not available in Spaces.');
  }
  return { ...value } as SpaceUpdatePatch;
}

export function decodeSpaceClientMessage(raw: string): SpaceClientMessage {
  const value = parseJsonFrame(raw);
  const type = text(value.type, 'type', 40);
  if (type === 'presence.heartbeat') {
    exactKeys(value, ['type']);
    return { type };
  }
  if (type === 'object.create') {
    exactKeys(value, ['type', 'requestId', 'idempotencyKey', 'node']);
    const node = normalizeNode(value.node);
    if (!node || !objectTypes.has(node.type)) fail('object.create node is not a valid Space object.');
    return { type, ...mutationEnvelope(value), node };
  }
  if (type === 'object.move') {
    exactKeys(value, ['type', 'requestId', 'idempotencyKey', 'objectId', 'patch']);
    return { type, ...mutationEnvelope(value), objectId: parseObjectId(value.objectId), patch: parseMovePatch(value.patch) };
  }
  if (type === 'object.update') {
    exactKeys(value, ['type', 'requestId', 'idempotencyKey', 'objectId', 'patch']);
    return { type, ...mutationEnvelope(value), objectId: parseObjectId(value.objectId), patch: parseUpdatePatch(value.patch) };
  }
  if (type === 'object.delete') {
    exactKeys(value, ['type', 'requestId', 'idempotencyKey', 'objectId']);
    return { type, ...mutationEnvelope(value), objectId: parseObjectId(value.objectId) };
  }
  fail(`Unknown Space event type ${type}.`);
}

export function decodeSpaceServerMessage(raw: string): SpaceServerMessage {
  const value = parseJsonFrame(raw, MAX_SPACE_SNAPSHOT_FRAME_BYTES);
  const type = text(value.type, 'type', 40);
  if (type === 'space.snapshot') {
    if (!Array.isArray(value.participants) || value.participants.some((item) => typeof item !== 'string')) {
      fail('Space snapshot participants are invalid.');
    }
    return {
      type,
      spaceId: text(value.spaceId, 'spaceId'),
      cursor: finite(value.cursor, 'cursor', 0, Number.MAX_SAFE_INTEGER),
      participantId: text(value.participantId, 'participantId'),
      participants: value.participants.slice(0, 1_000) as string[],
      workspace: normalizeWorkspace(value.workspace)
    };
  }
  if (type === 'space.event') {
    const event = decodeSpaceClientMessage(JSON.stringify(value.event));
    if (event.type === 'presence.heartbeat') fail('A durable Space event must be an object mutation.');
    return {
      type,
      spaceId: text(value.spaceId, 'spaceId'),
      cursor: finite(value.cursor, 'cursor', 0, Number.MAX_SAFE_INTEGER),
      event
    };
  }
  if (type === 'space.ack') {
    return {
      type,
      requestId: text(value.requestId, 'requestId', 100),
      cursor: finite(value.cursor, 'cursor', 0, Number.MAX_SAFE_INTEGER),
      replayed: value.replayed === true
    };
  }
  if (type === 'space.error') {
    return {
      type,
      requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
      code: text(value.code, 'code', 80),
      message: text(value.message, 'message', 500),
      retryable: value.retryable === true
    };
  }
  if (type === 'presence.join' || type === 'presence.leave') {
    return { type, participantId: text(value.participantId, 'participantId') };
  }
  if (type === 'presence.heartbeat') return { type, at: text(value.at, 'at', 80) };
  fail(`Unknown Space server event type ${type}.`);
}

export function encodeSpaceMessage(message: SpaceClientMessage | SpaceServerMessage): string {
  return JSON.stringify(message);
}
