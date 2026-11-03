import { emptyWorkspace, normalizeNode, type WorkspaceDoc, type WorkspaceLink, type WorkspaceNode } from '../../workspace/types.ts';
import {
  ReplicationError,
  type ReplicatedOperation,
  type ReplicationApplyResult,
  type ReplicationConflict,
  type ReplicationSnapshot,
  type SignatureVerifier
} from './types.ts';
import { validateReplicatedOperation } from './validation.ts';

type Register = { operation: ReplicatedOperation; value: unknown };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function observes(later: ReplicatedOperation, earlier: ReplicatedOperation) {
  return later.deviceId === earlier.deviceId
    ? later.sequence > earlier.sequence
    : (later.causalFrontier[earlier.deviceId] ?? 0) >= earlier.sequence;
}

function registerWinner(left: Register, right: Register) {
  if (observes(right.operation, left.operation)) return right;
  if (observes(left.operation, right.operation)) return left;
  return right.operation.operationId > left.operation.operationId ? right : left;
}

function flatten(value: Record<string, unknown>, prefix = ''): Array<[string, unknown]> {
  const output: Array<[string, unknown]> = [];
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) output.push(...flatten(entry as Record<string, unknown>, path));
    else output.push([path, entry]);
  }
  return output;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split('.');
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const existing = cursor[parts[index]];
    cursor[parts[index]] = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};
    cursor = cursor[parts[index]] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = value;
}

function conflict(targetId: string, field: string, winner: Register, loser: Register): ReplicationConflict {
  return {
    kind: 'concurrent-field',
    targetId,
    field,
    winnerOperationId: winner.operation.operationId,
    winnerValue: winner.value,
    loserOperationId: loser.operation.operationId,
    loserValue: loser.value
  };
}

function materialize(base: WorkspaceDoc, operations: ReplicatedOperation[]): { workspace: WorkspaceDoc; conflicts: ReplicationConflict[] } {
  const sorted = [...operations].sort((a, b) => a.operationId.localeCompare(b.operationId));
  const conflicts: ReplicationConflict[] = [];
  const baseNodes = new Map(base.nodes.map((node) => [node.id, node]));
  const baseLinks = new Map(base.links.map((link) => [link.id, link]));
  const creates = new Map<string, ReplicatedOperation[]>();
  const deletes = new Set<string>();
  const fields = new Map<string, Map<string, Register>>();
  const linkCreates = new Map<string, ReplicatedOperation[]>();
  const linkDeletes = new Set<string>();

  const write = (targetId: string, path: string, candidate: Register) => {
    const registers = fields.get(targetId) ?? new Map<string, Register>();
    const current = registers.get(path);
    if (!current) registers.set(path, candidate);
    else {
      const winner = registerWinner(current, candidate);
      const loser = winner === current ? candidate : current;
      if (!observes(winner.operation, loser.operation) && !observes(loser.operation, winner.operation) && canonical(winner.value) !== canonical(loser.value)) {
        conflicts.push(conflict(targetId, path, winner, loser));
      }
      registers.set(path, winner);
    }
    fields.set(targetId, registers);
  };

  for (const operation of sorted) {
    if (operation.kind === 'object.create') {
      const list = creates.get(operation.targetId) ?? [];
      list.push(operation);
      creates.set(operation.targetId, list);
    } else if (operation.kind === 'object.delete') deletes.add(operation.targetId);
    else if (operation.kind === 'object.move') {
      for (const [path, value] of Object.entries(operation.payload)) write(operation.targetId, path, { operation, value });
    } else if (operation.kind === 'object.update') {
      for (const [path, value] of flatten(operation.payload.patch as Record<string, unknown>)) write(operation.targetId, path, { operation, value });
    } else if (operation.kind === 'link.create') {
      const list = linkCreates.get(operation.targetId) ?? [];
      list.push(operation);
      linkCreates.set(operation.targetId, list);
    } else linkDeletes.add(operation.targetId);
  }

  const nodes: WorkspaceNode[] = [];
  for (const id of [...new Set([...baseNodes.keys(), ...creates.keys()])].sort()) {
    const candidates = creates.get(id) ?? [];
    const first = candidates[0];
    for (const reused of baseNodes.has(id) ? candidates : candidates.slice(1)) {
      conflicts.push({
        kind: 'id-reuse', targetId: id, field: 'id',
        winnerOperationId: first?.operationId ?? 'base', winnerValue: id,
        loserOperationId: reused.operationId, loserValue: id
      });
    }
    if (deletes.has(id)) continue;
    const source = baseNodes.get(id) ?? (first?.payload.node as WorkspaceNode | undefined);
    if (!source) continue;
    const raw = structuredClone(source) as unknown as Record<string, unknown>;
    const registers = fields.get(id);
    if (registers) for (const [path, entry] of [...registers.entries()].sort(([a], [b]) => a.localeCompare(b))) setPath(raw, path, entry.value);
    const touched = registers ? [...registers.values()].map((entry) => entry.operation) : [];
    if (touched.length) raw.updatedAt = [...touched].sort((a, b) => a.operationId.localeCompare(b.operationId)).at(-1)!.createdAt;
    const normalized = normalizeNode(raw);
    if (normalized) nodes.push(normalized);
  }

  const liveNodeIds = new Set(nodes.map((node) => node.id));
  const links: WorkspaceLink[] = [];
  for (const id of [...new Set([...baseLinks.keys(), ...linkCreates.keys()])].sort()) {
    if (linkDeletes.has(id)) continue;
    const candidates = linkCreates.get(id) ?? [];
    const first = candidates[0];
    const source = baseLinks.get(id) ?? (first?.payload.link as WorkspaceLink | undefined);
    if (!source || !liveNodeIds.has(source.fromId) || !liveNodeIds.has(source.toId)) continue;
    for (const reused of baseLinks.has(id) ? candidates : candidates.slice(1)) {
      conflicts.push({ kind: 'id-reuse', targetId: id, field: 'id', winnerOperationId: first?.operationId ?? 'base', winnerValue: id, loserOperationId: reused.operationId, loserValue: id });
    }
    links.push(structuredClone(source));
  }

  const updatedAt = sorted.length ? [...sorted].sort((a, b) => a.operationId.localeCompare(b.operationId)).at(-1)!.createdAt : base.updatedAt;
  return {
    workspace: {
      version: 1,
      revision: base.revision + sorted.length,
      updatedAt,
      viewport: { ...base.viewport },
      nextZ: Math.max(base.nextZ, ...nodes.map((node) => node.z + 1), 1),
      nodes,
      links
    },
    conflicts: conflicts.sort((a, b) => `${a.targetId}:${a.field}:${a.loserOperationId}`.localeCompare(`${b.targetId}:${b.field}:${b.loserOperationId}`))
  };
}

export class WorkspaceReplica {
  readonly accountId: string;
  readonly workspaceId: string;
  private readonly verifier: SignatureVerifier;
  private readonly base: WorkspaceDoc;
  private readonly operations = new Map<string, ReplicatedOperation>();
  private readonly sequenceIndex = new Map<string, string>();
  private readonly receivedSequences = new Map<string, Set<number>>();
  private readonly observedFrontier: Record<string, number> = {};

  constructor(options: { accountId: string; workspaceId: string; verifier: SignatureVerifier; base?: WorkspaceDoc }) {
    this.accountId = options.accountId;
    this.workspaceId = options.workspaceId;
    this.verifier = options.verifier;
    const seed = options.base ?? emptyWorkspace();
    this.base = structuredClone(seed);
  }

  apply(value: unknown): ReplicationApplyResult {
    const operation = validateReplicatedOperation(value);
    if (operation.accountId !== this.accountId || operation.workspaceId !== this.workspaceId) {
      throw new ReplicationError('invalid-operation', 'Operation belongs to a different account or workspace.');
    }
    if (!this.verifier(operation)) throw new ReplicationError('invalid-signature', 'Operation signature was not accepted.');
    const existing = this.operations.get(operation.operationId);
    if (existing) {
      if (canonical(existing) !== canonical(operation)) throw new ReplicationError('sequence-conflict', 'Operation identity was reused with different content.', { operationId: operation.operationId });
      return { applied: false, replayed: true, frontier: this.frontier() };
    }
    const sequenceKey = `${operation.deviceId}:${operation.sequence}`;
    const priorId = this.sequenceIndex.get(sequenceKey);
    if (priorId && priorId !== operation.operationId) throw new ReplicationError('sequence-conflict', 'Device sequence was reused.', { deviceId: operation.deviceId, sequence: operation.sequence });
    this.operations.set(operation.operationId, operation);
    this.sequenceIndex.set(sequenceKey, operation.operationId);
    const received = this.receivedSequences.get(operation.deviceId) ?? new Set<number>();
    received.add(operation.sequence);
    this.receivedSequences.set(operation.deviceId, received);
    let contiguous = this.observedFrontier[operation.deviceId] ?? 0;
    while (received.has(contiguous + 1)) contiguous += 1;
    if (contiguous > 0) this.observedFrontier[operation.deviceId] = contiguous;
    return { applied: true, replayed: false, frontier: this.frontier() };
  }

  frontier(): Readonly<Record<string, number>> {
    return Object.fromEntries(Object.entries(this.observedFrontier).sort(([a], [b]) => a.localeCompare(b)));
  }

  /**
   * Operations a peer has not acknowledged contiguously.
   *
   * A peer that received sequence 2 before sequence 1 advertises 0, so both
   * remain eligible. Replaying 2 is harmless and is preferable to making 1
   * permanently undiscoverable by treating a maximum as an acknowledgement.
   */
  readMissing(peerFrontier: Readonly<Record<string, number>>): ReplicatedOperation[] {
    for (const [deviceId, sequence] of Object.entries(peerFrontier)) {
      if (!deviceId || !Number.isSafeInteger(sequence) || sequence < 0) {
        throw new ReplicationError('invalid-operation', 'Peer frontier must contain non-negative safe integers.');
      }
    }
    return [...this.operations.values()]
      .filter((operation) => operation.sequence > (peerFrontier[operation.deviceId] ?? 0))
      .sort((left, right) => left.deviceId.localeCompare(right.deviceId) || left.sequence - right.sequence)
      .map((operation) => structuredClone(operation));
  }

  snapshot(): ReplicationSnapshot {
    const result = materialize(this.base, [...this.operations.values()]);
    return { ...result, frontier: this.frontier(), operationCount: this.operations.size };
  }
}
