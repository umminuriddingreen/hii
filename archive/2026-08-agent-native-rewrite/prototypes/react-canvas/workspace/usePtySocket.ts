'use client';

// Shared terminal transport for HII workspace objects.

export type PtyServerMessage = {
  t: 'created' | 'attached' | 'scrollback' | 'data' | 'exit' | 'killed' | 'sessions' | 'error';
  sessionId?: string;
  data?: string;
  exitCode?: number;
  alive?: boolean;
  message?: string;
  items?: unknown[];
  program?: 'shell' | 'hii';
};

export type PtyClientMessage = {
  t: 'create' | 'attach' | 'input' | 'resize' | 'kill' | 'list';
  sessionId?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  data?: string;
  program?: 'hii';
};

type Handler = (msg: PtyServerMessage) => void;

let socket: WebSocket | null = null;
let openPromise: Promise<WebSocket> | null = null;
const handlers = new Map<string, Set<Handler>>();
const pending: string[] = [];

function dispatch(msg: PtyServerMessage) {
  if (!msg.sessionId) return;
  for (const handler of handlers.get(msg.sessionId) ?? []) handler(msg);
}

function connect(): Promise<WebSocket> {
  if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
  if (openPromise) return openPromise;
  openPromise = new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/pty`);
    ws.onopen = () => {
      socket = ws;
      openPromise = null;
      while (pending.length) ws.send(pending.shift()!);
      resolve(ws);
    };
    ws.onmessage = (event) => {
      try {
        dispatch(JSON.parse(event.data));
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      // notify all subscribers so terminals can re-attach after reconnect
      for (const [sessionId, set] of handlers) {
        for (const handler of set) handler({ t: 'error', sessionId, message: 'socket closed' });
      }
    };
    ws.onerror = () => {
      openPromise = null;
      if (socket === ws) socket = null;
      reject(new Error('pty socket failed'));
    };
  });
  return openPromise;
}

export function ptySend(msg: PtyClientMessage) {
  const payload = JSON.stringify(msg);
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(payload);
  } else {
    pending.push(payload);
    connect().catch(() => {
      /* dev:next fallback — terminal nodes show the error */
    });
  }
}

export function ptySubscribe(sessionId: string, handler: Handler): () => void {
  let set = handlers.get(sessionId);
  if (!set) {
    set = new Set();
    handlers.set(sessionId, set);
  }
  set.add(handler);
  connect().catch(() => handler({ t: 'error', sessionId, message: 'pty gateway unreachable (run `npm run dev`, not dev:next)' }));
  return () => {
    set?.delete(handler);
    if (set && set.size === 0) handlers.delete(sessionId);
  };
}

export function ptyKill(sessionId: string) {
  ptySend({ t: 'kill', sessionId });
}
