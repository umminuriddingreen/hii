import { normalizeNode, workspaceNodeTypes, type WorkspaceLink, type WorkspaceNode } from '../../workspace/types.ts';
import {
  MAX_FRONTIER_DEVICES,
  MAX_OPERATION_BYTES,
  MAX_PATCH_FIELDS,
  MAX_PAYLOAD_BYTES,
  REPLICATION_SCHEMA_VERSION,
  ReplicationError,
  type ReplicatedOperation,
  type ReplicatedOperationKind
} from './types.ts';

const operationKinds = new Set<ReplicatedOperationKind>([
  'object.create',
  'object.move',
  'object.update',
  'object.delete',
  'link.create',
  'link.delete'
]);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new ReplicationError('invalid-operation', message, details);
}

function byteLength(value: unknown, code: 'operation-too-large' | 'payload-too-large', limit: number) {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    invalid('Replication data must be JSON serializable.');
  }
  if (encoded === undefined) invalid('Replication data must be JSON serializable.');
  const bytes = new TextEncoder().encode(encoded).byteLength;
  if (bytes > limit) {
    throw new ReplicationError(code, `Replication data exceeds the ${limit}-byte limit.`, { bytes, limit });
  }
}

function identifier(value: unknown, field: string, max = 128): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || !idPattern.test(value)) {
    invalid(`${field} must be a safe identifier of at most ${max} characters.`, { field });
  }
  return value;
}

function finite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${field} must be finite.`, { field });
  return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${field} must be an object.`, { field });
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) invalid(`${field} contains unsupported fields.`, { field, extra });
}

function validateNode(value: unknown): WorkspaceNode {
  const raw = record(value, 'payload.node');
  for (const field of ['id', 'type', 'x', 'y', 'w', 'h', 'z', 'createdAt', 'updatedAt', 'payload']) {
    if (!(field in raw)) invalid(`payload.node.${field} is required.`, { field });
  }
  if (typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))) invalid('payload.node.createdAt must be an ISO timestamp.');
  if (typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt))) invalid('payload.node.updatedAt must be an ISO timestamp.');
  const normalized = normalizeNode(raw);
  if (!normalized || normalized.id !== raw.id || !workspaceNodeTypes.includes(raw.type as WorkspaceNode['type'])) {
    invalid('payload.node is not a valid WorkspaceNode.');
  }
  if (normalized.id.length > 64) invalid('payload.node.id exceeds 64 characters.');
  return normalized;
}

function validateLink(value: unknown): WorkspaceLink {
  const raw = record(value, 'payload.link');
  exactKeys(raw, ['id', 'fromId', 'toId', 'label', 'arrow'], 'payload.link');
  const id = identifier(raw.id, 'payload.link.id', 64);
  const fromId = identifier(raw.fromId, 'payload.link.fromId', 64);
  const toId = identifier(raw.toId, 'payload.link.toId', 64);
  if (fromId === toId) invalid('A link cannot connect an object to itself.');
  if (raw.label !== undefined && (typeof raw.label !== 'string' || raw.label.length > 120)) invalid('payload.link.label exceeds 120 characters.');
  if (raw.arrow !== undefined && !['none', 'end', 'both'].includes(String(raw.arrow))) invalid('payload.link.arrow is invalid.');
  return { id, fromId, toId, ...(raw.label ? { label: raw.label as string } : {}), arrow: (raw.arrow ?? 'end') as WorkspaceLink['arrow'] };
}

function validatePayload(kind: ReplicatedOperationKind, targetId: string, value: unknown): Record<string, unknown> {
  const payload = record(value, 'payload');
  byteLength(payload, 'payload-too-large', MAX_PAYLOAD_BYTES);
  if (kind === 'object.create') {
    exactKeys(payload, ['node'], 'payload');
    const node = validateNode(payload.node);
    if (node.id !== targetId) invalid('targetId must equal payload.node.id.');
    return { node };
  }
  if (kind === 'object.move') {
    exactKeys(payload, ['x', 'y', 'z', 'rotation'], 'payload');
    return {
      x: finite(payload.x, 'payload.x'),
      y: finite(payload.y, 'payload.y'),
      ...(payload.z === undefined ? {} : { z: finite(payload.z, 'payload.z') }),
      ...(payload.rotation === undefined ? {} : { rotation: finite(payload.rotation, 'payload.rotation') })
    };
  }
  if (kind === 'object.update') {
    exactKeys(payload, ['patch'], 'payload');
    const patch = record(payload.patch, 'payload.patch');
    if (Object.keys(patch).length < 1 || Object.keys(patch).length > MAX_PATCH_FIELDS) invalid(`payload.patch must contain 1-${MAX_PATCH_FIELDS} fields.`);
    const forbidden = Object.keys(patch).filter((key) => ['id', 'createdAt'].includes(key));
    if (forbidden.length) invalid('Object identity and creation time are immutable.', { forbidden });
    return { patch };
  }
  if (kind === 'link.create') {
    exactKeys(payload, ['link'], 'payload');
    const link = validateLink(payload.link);
    if (link.id !== targetId) invalid('targetId must equal payload.link.id.');
    return { link };
  }
  exactKeys(payload, [], 'payload');
  return {};
}

export function validateReplicatedOperation(value: unknown): ReplicatedOperation {
  byteLength(value, 'operation-too-large', MAX_OPERATION_BYTES);
  const raw = record(value, 'operation');
  if (raw.schemaVersion !== REPLICATION_SCHEMA_VERSION) invalid('Unsupported replication schemaVersion.');
  const accountId = identifier(raw.accountId, 'accountId');
  const workspaceId = identifier(raw.workspaceId, 'workspaceId');
  const deviceId = identifier(raw.deviceId, 'deviceId');
  if (!Number.isSafeInteger(raw.sequence) || (raw.sequence as number) < 1) invalid('sequence must be a positive safe integer.');
  const sequence = raw.sequence as number;
  const operationId = identifier(raw.operationId, 'operationId', 260);
  if (operationId !== `${deviceId}:${sequence}`) invalid('operationId must equal deviceId:sequence.');
  if (!operationKinds.has(raw.kind as ReplicatedOperationKind)) invalid('Unknown replicated operation kind.');
  const kind = raw.kind as ReplicatedOperationKind;
  const targetId = identifier(raw.targetId, 'targetId', 64);
  const frontierRaw = record(raw.causalFrontier, 'causalFrontier');
  if (Object.keys(frontierRaw).length > MAX_FRONTIER_DEVICES) invalid(`causalFrontier exceeds ${MAX_FRONTIER_DEVICES} devices.`);
  const causalFrontier: Record<string, number> = {};
  for (const [frontierDevice, seen] of Object.entries(frontierRaw)) {
    identifier(frontierDevice, 'causalFrontier device');
    if (!Number.isSafeInteger(seen) || (seen as number) < 0) invalid('causalFrontier values must be non-negative safe integers.');
    if (frontierDevice === deviceId && (seen as number) >= sequence) invalid('An operation cannot causally observe itself or a future local operation.');
    causalFrontier[frontierDevice] = seen as number;
  }
  if (!Number.isSafeInteger(raw.keyEpoch) || (raw.keyEpoch as number) < 1) invalid('keyEpoch must be a positive safe integer.');
  if (typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))) invalid('createdAt must be an ISO timestamp.');
  if (typeof raw.signature !== 'string' || raw.signature.length < 1 || raw.signature.length > 4096) invalid('signature must contain 1-4096 characters.');
  const payload = validatePayload(kind, targetId, raw.payload);
  return {
    schemaVersion: REPLICATION_SCHEMA_VERSION,
    accountId,
    workspaceId,
    operationId,
    deviceId,
    sequence,
    causalFrontier,
    kind,
    targetId,
    payload,
    keyEpoch: raw.keyEpoch as number,
    createdAt: raw.createdAt,
    signature: raw.signature
  };
}
