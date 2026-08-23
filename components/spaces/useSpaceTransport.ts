'use client';

import { useEffect, useMemo, useState } from 'react';
import type { WorkspacePersistence } from '@/components/workspace/useWorkspace';
import {
  decodeSpaceServerMessage,
  encodeSpaceMessage,
  SPACE_PRESENCE_HEARTBEAT_MS,
  type SpaceObjectMutation
} from '@/lib/spaces/protocol';
import { emptyWorkspace, type WorkspaceDoc, type WorkspaceNode } from '@/lib/workspace/types';

type Pending = {
  message: SpaceObjectMutation;
  resolve: () => void;
  reject: (error: Error) => void;
};

const spatialKeys = ['x', 'y', 'w', 'h', 'z', 'rotation'] as const;
const semanticKeys = ['type', 'payload', 'object', 'objectRef', 'frameId', 'permissions'] as const;

function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function applyEvent(document: WorkspaceDoc, event: SpaceObjectMutation): WorkspaceDoc {
  let nodes = document.nodes;
  if (event.type === 'object.create') nodes = [...nodes.filter((node) => node.id !== event.node.id), event.node];
  if (event.type === 'object.move' || event.type === 'object.update') {
    nodes = nodes.map((node) => node.id === event.objectId ? { ...node, ...event.patch } as WorkspaceNode : node);
  }
  if (event.type === 'object.delete') nodes = nodes.filter((node) => node.id !== event.objectId);
  return { ...document, nodes, revision: document.revision + 1, updatedAt: new Date().toISOString() };
}

export class BrowserSpaceTransport implements WorkspacePersistence {
  private socket: WebSocket | null = null;
  private authoritative: WorkspaceDoc | null = null;
  private readonly listeners = new Set<(document: WorkspaceDoc) => void>();
  private readonly readers: Array<(document: WorkspaceDoc) => void> = [];
  private readonly pending = new Map<string, Pending>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private cursor = 0;
  private disposed = false;

  constructor(
    readonly spaceId: string,
    private readonly onParticipant: (participantId: string) => void = () => undefined
  ) {}

  private endpoint() {
    const url = new URL(`/api/spaces/${encodeURIComponent(this.spaceId)}/events`, window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  private connect() {
    if (this.disposed || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    void this.connectAuthenticated();
  }

  private async connectAuthenticated() {
    if (this.disposed || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    try {
      const response = await fetch(`/api/spaces/${encodeURIComponent(this.spaceId)}/guest-session`, {
        method: 'POST',
        credentials: 'same-origin'
      });
      if (!response.ok) throw new Error(`Guest session refused (${response.status}).`);
    } catch (error) {
      while (this.readers.length) this.readers.shift()?.(emptyWorkspace());
      for (const pending of this.pending.values()) pending.reject(error instanceof Error ? error : new Error('Guest session failed.'));
      this.pending.clear();
      return;
    }
    if (this.disposed) return;
    const socket = new WebSocket(this.endpoint());
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(encodeSpaceMessage({ type: 'presence.heartbeat' }));
      }, SPACE_PRESENCE_HEARTBEAT_MS);
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return socket.close(1003, 'Text messages required');
      let message;
      try {
        message = decodeSpaceServerMessage(event.data);
      } catch {
        socket.close(1007, 'Malformed server event');
        return;
      }
      if (message.type === 'space.snapshot') {
        if (message.spaceId !== this.spaceId) return socket.close(1008, 'Wrong Space snapshot');
        this.authoritative = message.workspace;
        this.cursor = message.cursor;
        this.onParticipant(message.participantId);
        for (const pending of this.pending.values()) socket.send(encodeSpaceMessage(pending.message));
        while (this.readers.length) this.readers.shift()?.(message.workspace);
        for (const listener of this.listeners) listener(message.workspace);
      } else if (message.type === 'space.event') {
        if (message.spaceId !== this.spaceId || !this.authoritative || message.cursor <= this.cursor) return;
        this.authoritative = applyEvent(this.authoritative, message.event);
        this.cursor = message.cursor;
        for (const listener of this.listeners) listener(this.authoritative);
      } else if (message.type === 'space.ack') {
        const pending = this.pending.get(message.requestId);
        if (pending) {
          this.pending.delete(message.requestId);
          pending.resolve();
        }
      } else if (message.type === 'space.error' && message.requestId) {
        const pending = this.pending.get(message.requestId);
        if (pending) {
          this.pending.delete(message.requestId);
          pending.reject(new Error(`${message.code}: ${message.message}`));
        }
      }
    });
    socket.addEventListener('close', () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      if (this.socket === socket) this.socket = null;
      if (!this.disposed) {
        const delay = Math.min(5_000, 250 * 2 ** this.reconnectAttempt++);
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      }
    });
  }

  read(): Promise<WorkspaceDoc> {
    if (this.authoritative) return Promise.resolve(this.authoritative);
    this.connect();
    return new Promise((resolve) => this.readers.push(resolve));
  }

  private dispatch(message: SpaceObjectMutation) {
    return new Promise<void>((resolve, reject) => {
      this.pending.set(message.requestId, { message, resolve, reject });
      this.connect();
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encodeSpaceMessage(message));
    });
  }

  async write(document: WorkspaceDoc): Promise<WorkspaceDoc> {
    const before = this.authoritative ?? await this.read();
    const previous = new Map(before.nodes.map((node) => [node.id, node]));
    const next = new Map(document.nodes.map((node) => [node.id, node]));
    const mutations: SpaceObjectMutation[] = [];
    const envelope = () => {
      const requestId = crypto.randomUUID();
      return { requestId, idempotencyKey: requestId };
    };
    for (const node of document.nodes) {
      const old = previous.get(node.id);
      if (!old) {
        mutations.push({ type: 'object.create', ...envelope(), node: { ...node, spaceId: this.spaceId } });
        continue;
      }
      const moveChanged = spatialKeys.some((key) => !same(old[key], node[key]));
      if (moveChanged) {
        mutations.push({
          type: 'object.move',
          ...envelope(),
          objectId: node.id,
          patch: { x: node.x, y: node.y, w: node.w, h: node.h, z: node.z, rotation: node.rotation ?? 0 }
        });
      }
      const updateChanged = semanticKeys.some((key) => !same(old[key], node[key]));
      if (updateChanged) {
        mutations.push({
          type: 'object.update',
          ...envelope(),
          objectId: node.id,
          patch: Object.fromEntries(semanticKeys.map((key) => [key, node[key]]))
        });
      }
    }
    for (const node of before.nodes) {
      if (!next.has(node.id)) mutations.push({ type: 'object.delete', ...envelope(), objectId: node.id });
    }
    for (const mutation of mutations) await this.dispatch(mutation);
    return this.authoritative ?? { ...emptyWorkspace(), viewport: document.viewport };
  }

  subscribe(listener: (document: WorkspaceDoc) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.socket?.close(1000, 'Space canvas closed');
    for (const pending of this.pending.values()) pending.reject(new Error('Space transport closed.'));
    this.pending.clear();
  }
}

export function useSpaceTransport(spaceId: string) {
  const [participantId, setParticipantId] = useState('guest:pending');
  const transport = useMemo(() => new BrowserSpaceTransport(spaceId, setParticipantId), [spaceId]);
  useEffect(() => () => transport.dispose(), [transport]);
  return { participantId, persistence: transport as WorkspacePersistence };
}
