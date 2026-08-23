import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { GraphMutationError, type OperationalOperation } from '../../operational-graph/types.ts';
import { applyGraphMutation } from '../../server/operational-graph-mutations.ts';
import { readOperationalSpace } from '../../server/operational-object-store.ts';
import { readSpace, updateSpace, SpaceLoadError, SpaceNotFoundError, validateSpaceId } from '../../server/space-store.ts';
import { readWorkspace, writeGraphCanonicalWorkspace } from '../../server/workspace-store.ts';
import {
  decodeSpaceClientMessage,
  encodeSpaceMessage,
  MAX_SPACE_EVENT_FRAME_BYTES,
  MAX_SPACE_SNAPSHOT_FRAME_BYTES,
  SPACE_PRESENCE_HEARTBEAT_MS,
  SPACE_PRESENCE_TIMEOUT_MS,
  type SpaceClientMessage,
  type SpaceObjectMutation,
  type SpaceServerMessage
} from '../protocol.ts';
import { normalizeNode, type WorkspaceDoc, type WorkspaceNode } from '../../workspace/types.ts';
import { isAllowedSpacesPeer, type SpacesHostBinding } from './network.ts';
import { assertGuestOwnsObject, type GuestClaims } from '../guest.ts';
import { ParticipantPresenceRegistry } from '../participant-presence.ts';
import { evaluateSpacePolicy, spacePolicyForMode, type SpacePolicyMode } from '../policy.ts';
import { SpaceAuthorityError, type SpaceHostAuthority } from './authority.ts';
import type { SpaceAudience } from '../types.ts';
import type { SpacePolicy } from '../types.ts';

type RawData = Buffer | ArrayBuffer | Buffer[];
type WebSocketLike = {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): void;
  on(event: 'close' | 'pong' | 'error', listener: () => void): void;
};
type WebSocketServerLike = {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (socket: WebSocketLike) => void): void;
  close(callback: (error?: Error) => void): void;
};
type WebSocketServerConstructor = new (options: Record<string, unknown>) => WebSocketServerLike;

const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws') as { WebSocketServer: WebSocketServerConstructor };
const OPEN = 1;
const SPACE_PROJECTION = 'space-spatial';
const GRAPH_PREFIX = 'space:';
export const MAX_SPACE_EVENT_CONNECTIONS = 128;
export const MAX_SPACE_EVENT_CONNECTIONS_PER_PEER = 16;
export const MAX_SPACE_SOCKET_BUFFER_BYTES = MAX_SPACE_SNAPSHOT_FRAME_BYTES + 1024 * 1024;

type Connection = {
  socket: WebSocketLike;
  spaceId: string;
  participantId: string;
  actor: 'guest' | 'invite';
  deviceId: string;
  credential: string;
  expiresAt: number;
  peer: string;
  ready: boolean;
  lastSeen: number;
  closed: boolean;
  frameWindowStartedAt: number;
  framesInWindow: number;
};

export type SpaceEventHubOptions = {
  server: Server;
  binding: SpacesHostBinding;
  allowedHostnames: ReadonlySet<string>;
  normalizeHostname(raw: string): string | null;
  hasSameOrigin(request: IncomingMessage, hostname: string): boolean;
  maxFrameBytes?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  authority: SpaceHostAuthority;
  audience: SpaceAudience;
  /** A public proxy listener is scoped to exactly one explicitly published Space. */
  publicSpaceId?: string;
};

export type SpaceEventHub = {
  close(): Promise<void>;
  connectionCount(spaceId?: string): number;
  participant(spaceId: string, participantId: string): GuestClaims | null;
  revokeParticipant(spaceId: string, participantId: string): Promise<boolean>;
  removeObject(spaceId: string, objectId: string): Promise<void>;
  clearSpace(spaceId: string): Promise<number>;
  updatePolicy(spaceId: string, policy: Partial<SpacePolicy>): Promise<Awaited<ReturnType<typeof updateSpace>>>;
  setPolicyMode(spaceId: string, mode: SpacePolicyMode): Promise<Awaited<ReturnType<typeof updateSpace>>>;
};

function rejectUpgrade(socket: Duplex, status: number, reason: string) {
  if (socket.destroyed) return;
  const body = `${reason}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  );
}

function graphObjectId(spaceId: string, objectId: string) {
  return `${GRAPH_PREFIX}${spaceId}:object:${objectId}`;
}

function clientObjectId(spaceId: string, objectId: string): string | null {
  const prefix = graphObjectId(spaceId, '');
  return objectId.startsWith(prefix) ? objectId.slice(prefix.length) : null;
}

function cursor(operations: OperationalOperation[]) {
  return operations.length === 0 ? 0 : operations[operations.length - 1].lamport;
}

function semanticNode(node: WorkspaceNode) {
  return {
    id: node.id,
    type: node.type,
    spaceId: node.spaceId,
    creatorId: node.creatorId,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    permissions: node.permissions,
    object: node.object,
    objectRef: node.objectRef,
    frameId: node.frameId,
    payload: node.payload
  };
}

function spatialNode(node: WorkspaceNode) {
  return { x: node.x, y: node.y, w: node.w, h: node.h, z: node.z, rotation: node.rotation ?? 0 };
}

async function graphWorkspace(spaceId: string): Promise<{ workspace: WorkspaceDoc; cursor: number; needsPersistence: boolean }> {
  const [base, graph] = await Promise.all([readWorkspace(spaceId), Promise.resolve(readOperationalSpace(spaceId))]);
  const projections = new Map(
    graph.projections
      .filter((projection) => projection.deletedAt === null && projection.projection === SPACE_PROJECTION)
      .map((projection) => [projection.objectId, projection.state])
  );
  const nodes = graph.objects.flatMap((object) => {
    if (object.deletedAt !== null || object.canonicalSource !== 'graph') return [];
    const id = clientObjectId(spaceId, object.id);
    const stored = object.properties.spaceNode;
    const projection = projections.get(object.id);
    if (!id || !stored || typeof stored !== 'object' || !projection) return [];
    const node = normalizeNode({ ...(stored as Record<string, unknown>), ...projection, id, spaceId });
    return node ? [node] : [];
  });
  return {
    workspace: {
      ...base,
      nodes,
      links: [],
      nextZ: Math.max(1, ...nodes.map((node) => node.z + 1))
    },
    cursor: cursor(graph.operations),
    needsPersistence: JSON.stringify(base.nodes) !== JSON.stringify(nodes) || base.links.length !== 0
  };
}

function previousOperation(spaceId: string, key: string) {
  return readOperationalSpace(spaceId).operations.find((operation) => operation.idempotencyKey === key);
}

function mutationBase(spaceId: string, key: string, currentVersion: number | null) {
  return previousOperation(spaceId, key)?.baseVersion ?? currentVersion;
}

function send(socket: WebSocketLike, message: SpaceServerMessage): boolean {
  if (socket.readyState !== OPEN) return false;
  if (socket.bufferedAmount > MAX_SPACE_SOCKET_BUFFER_BYTES) {
    socket.terminate();
    return false;
  }
  socket.send(encodeSpaceMessage(message));
  return true;
}

function errorCode(error: unknown) {
  if (error instanceof GraphMutationError) return error.code;
  if (error instanceof SpaceNotFoundError) return 'SPACE_NOT_FOUND';
  if (error instanceof SpaceLoadError) return 'SPACE_UNAVAILABLE';
  if (error instanceof SpaceAuthorityError) return error.code;
  return 'MUTATION_REFUSED';
}

function semanticPatch(node: WorkspaceNode) {
  return {
    type: node.type,
    payload: node.payload,
    object: node.object,
    objectRef: node.objectRef,
    frameId: node.frameId,
    permissions: node.permissions
  };
}

function canonicalMutation(message: SpaceObjectMutation, node?: WorkspaceNode): SpaceObjectMutation {
  if (message.type === 'object.create') return { ...message, node: node ?? message.node };
  if (message.type === 'object.delete') return message;
  if (!node) return message;
  if (message.type === 'object.move') return { ...message, patch: spatialNode(node) };
  return { ...message, patch: semanticPatch(node) };
}

function requireSnapshotBudget(workspace: WorkspaceDoc, nodes: WorkspaceNode[]) {
  const bytes = Buffer.byteLength(JSON.stringify({ ...workspace, nodes }), 'utf8');
  if (bytes > MAX_SPACE_SNAPSHOT_FRAME_BYTES - MAX_SPACE_EVENT_FRAME_BYTES) {
    throw new GraphMutationError('authority-mismatch', 'This mutation would exceed the Space snapshot size limit.');
  }
}

async function applySpaceMutation(
  spaceId: string,
  actorId: string,
  deviceId: string,
  message: SpaceObjectMutation,
  role: 'guest' | 'invite' | 'host' = 'guest',
  audience: SpaceAudience = 'local'
): Promise<{ event: SpaceObjectMutation; cursor: number; replayed: boolean }> {
  const space = await readSpace(spaceId);
  const before = await graphWorkspace(spaceId);
  if (role !== 'host') {
    const decision = {
      audience,
      actor: role,
      operation: 'write' as const,
      createsObject: message.type === 'object.create',
      objectCount: before.workspace.nodes.length
    };
    const policy = evaluateSpacePolicy(space.policy, decision);
    if (!policy.allowed) throw new SpaceAuthorityError(policy.reason, `Space policy refused ${message.type}.`, policy.reason === 'POLICY_WRITES_FROZEN' ? 423 : 403);
  }
  const byId = new Map(before.workspace.nodes.map((node) => [node.id, node]));
  const graph = readOperationalSpace(spaceId);
  const graphId = graphObjectId(spaceId, message.type === 'object.create' ? message.node.id : message.objectId);
  const storedObject = graph.objects.find((entry) => entry.id === graphId);
  const object = storedObject?.deletedAt === null ? storedObject : undefined;
  const projection = graph.projections.find(
    (entry) => entry.objectId === graphId && entry.projection === SPACE_PROJECTION && entry.deletedAt === null
  );
  const actor = { actorId, deviceId };
  let acceptedNode: WorkspaceNode | undefined;
  let finalCursor = before.cursor;
  let replayed = false;

  const replayKey = message.type === 'object.create'
    ? `${message.idempotencyKey}:semantic`
    : message.idempotencyKey;
  const replay = previousOperation(spaceId, replayKey);
  if (replay && replay.actorId !== actorId) {
    throw new SpaceAuthorityError('IDEMPOTENCY_ACTOR_MISMATCH', 'Idempotent mutation belongs to another participant.', 403);
  }

  if (message.type === 'object.create') {
    const semanticKey = `${message.idempotencyKey}:semantic`;
    const projectionKey = `${message.idempotencyKey}:projection`;
    const previousCreate = previousOperation(spaceId, semanticKey);
    const previousProjection = previousOperation(spaceId, projectionKey);
    const previousProperties = previousCreate?.payload.properties;
    const previousNode = previousProperties && typeof previousProperties === 'object'
      ? (previousProperties as Record<string, unknown>).spaceNode
      : undefined;
    const previousState = previousProjection?.payload.state;
    if (message.node.spaceId !== spaceId) throw new TypeError('Object Space identity does not match the event route.');
    if ((byId.has(message.node.id) || object) && !previousCreate) throw new GraphMutationError('invalid-operation', 'Object already exists.');
    if (!previousCreate && before.workspace.nodes.length >= space.policy.maxObjects) {
      throw new GraphMutationError('authority-mismatch', 'This Space has reached its object limit.');
    }
    acceptedNode = previousCreate
      ? byId.get(message.node.id) ?? normalizeNode({
          ...((previousNode as Record<string, unknown> | undefined) ?? (storedObject?.properties.spaceNode as Record<string, unknown> | undefined) ?? semanticNode(message.node)),
          ...((previousState as Record<string, unknown> | undefined) ?? spatialNode(message.node)),
          id: message.node.id,
          spaceId
        }) ?? undefined
      : normalizeNode({
          ...message.node,
          spaceId,
          creatorId: actorId,
          permissions: { inheritance: 'space-policy' },
          updatedAt: new Date().toISOString()
        }) ?? undefined;
    if (!acceptedNode) throw new TypeError('Object is invalid.');
    requireSnapshotBudget(before.workspace, [...before.workspace.nodes.filter((node) => node.id !== acceptedNode!.id), acceptedNode]);
    const created = applyGraphMutation({
      spaceId,
      type: 'CREATE_OBJECT',
      actor: { actorId: previousCreate?.actorId ?? actorId },
      idempotencyKey: semanticKey,
      payload: {
        id: graphId,
        type: acceptedNode.type,
        ownerActorId: actorId,
        provenanceClass: 'authored',
        properties: { spaceNode: semanticNode(acceptedNode) }
      }
    });
    const projected = applyGraphMutation({
      spaceId,
      type: 'UPSERT_PROJECTION',
      actor: { actorId: previousProjection?.actorId ?? actorId },
      idempotencyKey: projectionKey,
      baseVersion: mutationBase(spaceId, projectionKey, null),
      payload: { objectId: graphId, projection: SPACE_PROJECTION, state: spatialNode(acceptedNode) }
    });
    finalCursor = projected.lamport;
    replayed = created.replayed && projected.replayed;
  } else if (!object && !(message.type === 'object.delete' && previousOperation(spaceId, message.idempotencyKey))) {
    throw new GraphMutationError('missing-target', `Object ${message.objectId} does not exist.`);
  } else if (message.type === 'object.move') {
    const current = byId.get(message.objectId);
    if (!current || !projection) throw new GraphMutationError('missing-target', 'Object projection does not exist.');
    if (role !== 'host') assertGuestOwnsObject({ guestId: actorId, spaceId }, current);
    const previous = previousOperation(spaceId, message.idempotencyKey);
    acceptedNode = previous ? current : normalizeNode({ ...current, ...message.patch, updatedAt: new Date().toISOString() }) ?? undefined;
    if (!acceptedNode) throw new TypeError('Move is invalid.');
    requireSnapshotBudget(before.workspace, before.workspace.nodes.map((node) => node.id === acceptedNode!.id ? acceptedNode! : node));
    const result = applyGraphMutation({
      spaceId,
      type: 'PATCH_PROJECTION',
      actor: { actorId: previous?.actorId ?? actorId },
      idempotencyKey: message.idempotencyKey,
      baseVersion: mutationBase(spaceId, message.idempotencyKey, projection.projectionVersion),
      payload: { objectId: graphId, projection: SPACE_PROJECTION, state: spatialNode(acceptedNode) }
    });
    finalCursor = result.lamport;
    replayed = result.replayed;
  } else if (message.type === 'object.update') {
    const current = byId.get(message.objectId);
    if (!current) throw new GraphMutationError('missing-target', `Object ${message.objectId} does not exist.`);
    if (role !== 'host') assertGuestOwnsObject({ guestId: actorId, spaceId }, current);
    const previous = previousOperation(spaceId, message.idempotencyKey);
    acceptedNode = previous ? current : normalizeNode({ ...current, ...message.patch, id: current.id, spaceId, creatorId: current.creatorId, updatedAt: new Date().toISOString() }) ?? undefined;
    if (!acceptedNode) throw new TypeError('Update is invalid.');
    requireSnapshotBudget(before.workspace, before.workspace.nodes.map((node) => node.id === acceptedNode!.id ? acceptedNode! : node));
    const result = applyGraphMutation({
      spaceId,
      type: 'PATCH_OBJECT',
      actor: { actorId: previous?.actorId ?? actorId },
      idempotencyKey: message.idempotencyKey,
      baseVersion: mutationBase(spaceId, message.idempotencyKey, object!.semanticVersion),
      payload: { id: graphId, type: acceptedNode.type, properties: { spaceNode: semanticNode(acceptedNode) } }
    });
    finalCursor = result.lamport;
    replayed = result.replayed;
  } else {
    const current = byId.get(message.objectId);
    if (role !== 'host' && current) assertGuestOwnsObject({ guestId: actorId, spaceId }, current);
    const previous = previousOperation(spaceId, message.idempotencyKey);
    const result = applyGraphMutation({
      spaceId,
      type: 'TOMBSTONE_OBJECT',
      actor: { actorId: previous?.actorId ?? actorId },
      idempotencyKey: message.idempotencyKey,
      baseVersion: mutationBase(spaceId, message.idempotencyKey, object?.semanticVersion ?? null),
      payload: { id: graphId }
    });
    finalCursor = result.lamport;
    replayed = result.replayed;
  }

  const materialized = await graphWorkspace(spaceId);
  if (materialized.needsPersistence) {
    await writeGraphCanonicalWorkspace(materialized.workspace, materialized.workspace.revision, spaceId);
  }
  return { event: canonicalMutation(message, acceptedNode), cursor: finalCursor, replayed };
}

export function createSpaceEventHub(options: SpaceEventHubOptions): SpaceEventHub {
  const maxFrameBytes = options.maxFrameBytes ?? MAX_SPACE_EVENT_FRAME_BYTES;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? SPACE_PRESENCE_HEARTBEAT_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? SPACE_PRESENCE_TIMEOUT_MS;
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: maxFrameBytes, perMessageDeflate: false });
  const connections = new Set<Connection>();
  const queues = new Map<string, Promise<void>>();
  const presence = new ParticipantPresenceRegistry({ timeoutMs: heartbeatTimeoutMs });

  const broadcast = (spaceId: string, message: SpaceServerMessage, except?: Connection) => {
    for (const connection of connections) {
      if (connection !== except && connection.ready && connection.spaceId === spaceId) send(connection.socket, message);
    }
  };

  const leave = (connection: Connection) => {
    if (connection.closed) return;
    connection.closed = true;
    connections.delete(connection);
    if (![...connections].some((entry) => entry.spaceId === connection.spaceId && entry.participantId === connection.participantId)) {
      if (presence.leave(connection.spaceId, connection.participantId, connection.deviceId)) {
        broadcast(connection.spaceId, { type: 'presence.leave', participantId: connection.participantId });
      }
    }
  };

  const enqueue = <T>(spaceId: string, task: () => Promise<T>): Promise<T> => {
    const previous = queues.get(spaceId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    const settled = next.then(() => undefined, () => undefined);
    queues.set(spaceId, settled);
    void settled.finally(() => {
      if (queues.get(spaceId) === settled) queues.delete(spaceId);
    });
    return next;
  };

  const accept = async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (request.method !== 'GET') return rejectUpgrade(socket, 405, 'Method Not Allowed');
    if (!isAllowedSpacesPeer(request.socket.remoteAddress, options.binding)) return rejectUpgrade(socket, 403, 'Forbidden');
    const peer = request.socket.remoteAddress ?? 'unknown';
    const capacityAvailable = () =>
      connections.size < MAX_SPACE_EVENT_CONNECTIONS &&
      [...connections].filter((connection) => connection.peer === peer).length < MAX_SPACE_EVENT_CONNECTIONS_PER_PEER;
    if (!capacityAvailable()) return rejectUpgrade(socket, 503, 'Service Unavailable');
    const hostname = options.normalizeHostname(request.headers.host ?? '');
    if (!hostname || !options.allowedHostnames.has(hostname)) return rejectUpgrade(socket, 421, 'Misdirected Request');
    if (!options.hasSameOrigin(request, hostname)) return rejectUpgrade(socket, 403, 'Forbidden');
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://hii-spaces.invalid');
    } catch {
      return rejectUpgrade(socket, 400, 'Bad Request');
    }
    const match = /^\/api\/spaces\/([^/]+)\/events$/.exec(url.pathname);
    if (!match || url.search !== '') return rejectUpgrade(socket, 404, 'Not Found');
    let spaceId: string;
    let space: Awaited<ReturnType<typeof readSpace>>;
    try {
      spaceId = validateSpaceId(decodeURIComponent(match[1]));
      space = await readSpace(spaceId);
      if (
        options.audience === 'public' &&
        (spaceId !== options.publicSpaceId || space.publication.state !== 'published')
      ) {
        throw new SpaceNotFoundError(spaceId);
      }
    } catch (error) {
      if (error instanceof SpaceNotFoundError) return rejectUpgrade(socket, 404, 'Not Found');
      if (error instanceof SpaceLoadError) return rejectUpgrade(socket, 503, 'Service Unavailable');
      if (error instanceof SpaceAuthorityError) return rejectUpgrade(socket, error.status, 'Forbidden');
      return rejectUpgrade(socket, 400, 'Bad Request');
    }
    let guest: ReturnType<SpaceHostAuthority['authenticate']>;
    try {
      guest = options.authority.authenticate(request, spaceId);
      options.authority.authorize(space, options.audience, 'join', guest.actor);
      options.authority.authorize(space, options.audience, 'read', guest.actor);
    } catch (error) {
      return rejectUpgrade(socket, error instanceof SpaceAuthorityError ? error.status : 401, 'Unauthorized');
    }
    if (!capacityAvailable()) return rejectUpgrade(socket, 503, 'Service Unavailable');

    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      const connection: Connection = {
        socket: webSocket,
        spaceId,
        participantId: guest.guestId,
        actor: guest.actor,
        deviceId: guest.deviceId,
        credential: guest.cookieValue,
        expiresAt: guest.expiresAt,
        peer,
        ready: false,
        lastSeen: Date.now(),
        closed: false,
        frameWindowStartedAt: Date.now(),
        framesInWindow: 0
      };
      connections.add(connection);
      const alreadyPresent = presence.list(spaceId).some((entry) => entry.participantId === guest.guestId);
      presence.join(spaceId, guest.guestId, guest.deviceId);
      enqueue(spaceId, async () => {
        try {
          const snapshot = await graphWorkspace(spaceId);
          if (connection.closed) return;
          if (!send(webSocket, {
            type: 'space.snapshot',
            spaceId,
            cursor: snapshot.cursor,
            participantId: connection.participantId,
            participants: presence.list(spaceId).map((entry) => entry.participantId),
            workspace: snapshot.workspace
          })) return;
          connection.ready = true;
          if (!alreadyPresent) broadcast(spaceId, { type: 'presence.join', participantId: connection.participantId }, connection);
        } catch {
          webSocket.close(1011, 'Snapshot unavailable');
        }
      });

      webSocket.on('pong', () => { connection.lastSeen = Date.now(); });
      webSocket.on('error', () => leave(connection));
      webSocket.on('close', () => leave(connection));
      webSocket.on('message', async (data, isBinary) => {
        connection.lastSeen = Date.now();
        const now = Date.now();
        if (now - connection.frameWindowStartedAt >= 10_000) {
          connection.frameWindowStartedAt = now;
          connection.framesInWindow = 0;
        }
        connection.framesInWindow += 1;
        if (connection.framesInWindow > 120) return webSocket.close(1008, 'Message rate exceeded');
        const bytes = Array.isArray(data)
          ? data.reduce((total, part) => total + part.byteLength, 0)
          : data instanceof ArrayBuffer ? data.byteLength : data.byteLength;
        if (isBinary || bytes > maxFrameBytes) return webSocket.close(1009, 'Text frame required');
        let message: SpaceClientMessage;
        try {
          message = decodeSpaceClientMessage(Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8'));
        } catch {
          webSocket.close(1007, 'Malformed Space event');
          return;
        }
        if (message.type === 'presence.heartbeat') {
          try {
            options.authority.authenticate(request, spaceId);
            const latest = await readSpace(spaceId);
            options.authority.authorize(latest, options.audience, 'read', 'guest');
            presence.heartbeat(spaceId, connection.participantId, connection.deviceId);
          } catch {
            webSocket.close(1008, 'Credential or policy refused');
            return;
          }
          send(webSocket, { type: 'presence.heartbeat', at: new Date().toISOString() });
          return;
        }
        enqueue(spaceId, async () => {
          try {
            const currentGuest = options.authority.authenticate(request, spaceId);
            const accepted = await applySpaceMutation(spaceId, currentGuest.guestId, currentGuest.deviceId, message, currentGuest.actor, options.audience);
            if (!accepted.replayed) {
              broadcast(spaceId, { type: 'space.event', spaceId, cursor: accepted.cursor, event: accepted.event });
            }
            send(webSocket, { type: 'space.ack', requestId: message.requestId, cursor: accepted.cursor, replayed: accepted.replayed });
          } catch (error) {
            send(webSocket, {
              type: 'space.error',
              requestId: message.requestId,
              code: errorCode(error),
              message: error instanceof Error ? error.message : 'Mutation refused.',
              retryable: error instanceof GraphMutationError && error.code === 'stale-version'
            });
          }
        });
      });
    });
  };

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void accept(request, socket, head).catch(() => rejectUpgrade(socket, 500, 'Internal Server Error'));
  };
  options.server.on('upgrade', onUpgrade);
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const expired of presence.expire(now)) {
      broadcast(expired.spaceId, { type: 'presence.leave', participantId: expired.participantId });
    }
    for (const connection of connections) {
      if (now - connection.lastSeen > heartbeatTimeoutMs) {
        connection.socket.terminate();
        leave(connection);
      } else {
        connection.socket.ping();
      }
    }
  }, heartbeatIntervalMs);
  heartbeat.unref?.();

  return {
    connectionCount(spaceId) {
      return [...connections].filter((connection) => !spaceId || connection.spaceId === spaceId).length;
    },
    participant(spaceId, participantId) {
      const connection = [...connections].find((entry) => entry.spaceId === spaceId && entry.participantId === participantId);
      return connection ? {
        version: 1,
        spaceId,
        guestId: participantId,
        deviceId: connection.deviceId,
        issuedAt: 0,
        expiresAt: connection.expiresAt
      } : null;
    },
    revokeParticipant(spaceId, participantId) {
      return enqueue(spaceId, async () => {
        const matches = [...connections].filter((entry) => entry.spaceId === spaceId && entry.participantId === participantId);
        for (const connection of matches) {
          options.authority.revoke({
            spaceId,
            guestId: participantId,
            expiresAt: connection.expiresAt
          });
          connection.ready = false;
          connection.socket.close(1008, 'Participant removed');
        }
        return matches.length > 0;
      });
    },
    removeObject(spaceId, objectId) {
      return enqueue(spaceId, async () => {
        const id = randomUUID();
        const accepted = await applySpaceMutation(spaceId, 'host', 'host', { type: 'object.delete', requestId: id, idempotencyKey: `host:${id}`, objectId }, 'host');
        broadcast(spaceId, { type: 'space.event', spaceId, cursor: accepted.cursor, event: accepted.event });
      });
    },
    clearSpace(spaceId) {
      return enqueue(spaceId, async () => {
        const snapshot = await graphWorkspace(spaceId);
        for (const node of snapshot.workspace.nodes) {
          const id = randomUUID();
          const accepted = await applySpaceMutation(spaceId, 'host', 'host', { type: 'object.delete', requestId: id, idempotencyKey: `host:${id}`, objectId: node.id }, 'host');
          broadcast(spaceId, { type: 'space.event', spaceId, cursor: accepted.cursor, event: accepted.event });
        }
        return snapshot.workspace.nodes.length;
      });
    },
    updatePolicy(spaceId, policy) {
      return enqueue(spaceId, async () => {
        const updated = await updateSpace(spaceId, { policy });
        for (const connection of [...connections]) {
          if (connection.spaceId !== spaceId) continue;
          const join = evaluateSpacePolicy(updated.policy, { audience: options.audience, actor: connection.actor, operation: 'join' });
          const read = evaluateSpacePolicy(updated.policy, { audience: options.audience, actor: connection.actor, operation: 'read' });
          if (!join.allowed || !read.allowed) {
            connection.ready = false;
            connection.socket.close(1008, 'Space policy changed');
          }
        }
        return updated;
      });
    },
    setPolicyMode(spaceId, mode) {
      return enqueue(spaceId, async () => {
        const current = await readSpace(spaceId);
        const updated = await updateSpace(spaceId, { policy: spacePolicyForMode(mode, current.policy) });
        for (const connection of [...connections]) {
          if (connection.spaceId !== spaceId) continue;
          const join = evaluateSpacePolicy(updated.policy, { audience: options.audience, actor: connection.actor, operation: 'join' });
          const read = evaluateSpacePolicy(updated.policy, { audience: options.audience, actor: connection.actor, operation: 'read' });
          if (!join.allowed || !read.allowed) {
            connection.ready = false;
            connection.socket.close(1008, 'Space policy changed');
          }
        }
        return updated;
      });
    },
    async close() {
      clearInterval(heartbeat);
      options.server.off('upgrade', onUpgrade);
      for (const connection of connections) connection.socket.terminate();
      connections.clear();
      await Promise.allSettled(queues.values());
      await new Promise<void>((resolve, reject) => webSockets.close((error) => error ? reject(error) : resolve()));
    }
  };
}
