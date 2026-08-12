import {
  attach,
  createSession,
  detach,
  getSession,
  kill,
  listSessions,
  resize,
  scrollbackText,
  write
} from './pty-sessions.mjs';

export function isLocalRequest(req) {
  if (process.env.HII_LOCAL_TERMINAL_ENABLED === '1') return true;
  const host = req.headers.host ?? '';
  const hostOk = host.startsWith('localhost:') || host.startsWith('127.0.0.1:') || host.startsWith('[::1]:');
  const origin = req.headers.origin;
  const originOk =
    !origin ||
    origin.startsWith('http://localhost:') ||
    origin.startsWith('http://127.0.0.1:') ||
    origin.startsWith('http://[::1]:');
  return hostOk && originOk;
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

export function attachPtyGateway(wss) {
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, { t: 'error', message: 'invalid json' });
      }
      const { t, sessionId } = msg;
      try {
        if (t === 'create') {
          if (typeof sessionId !== 'string' || !sessionId) return send(ws, { t: 'error', message: 'sessionId required' });
          if (msg.program && msg.program !== 'hii') return send(ws, { t: 'error', sessionId, message: 'unsupported PTY program' });
          const session = createSession(sessionId, { cwd: msg.cwd, cols: msg.cols, rows: msg.rows, program: msg.program });
          session.subscribers.add(ws);
          send(ws, { t: 'created', sessionId, program: session.program });
          const buffered = scrollbackText(session);
          if (buffered) send(ws, { t: 'scrollback', sessionId, data: buffered });
        } else if (t === 'attach') {
          const session = attach(sessionId, ws);
          if (!session) return send(ws, { t: 'error', sessionId, message: 'unknown session' });
          send(ws, { t: 'attached', sessionId, alive: session.pty !== null, exitCode: session.exitCode });
          send(ws, { t: 'scrollback', sessionId, data: scrollbackText(session) });
          if (msg.cols && msg.rows) resize(sessionId, msg.cols, msg.rows);
        } else if (t === 'input') {
          write(sessionId, msg.data);
        } else if (t === 'resize') {
          resize(sessionId, msg.cols, msg.rows);
        } else if (t === 'kill') {
          kill(sessionId);
          send(ws, { t: 'killed', sessionId });
        } else if (t === 'list') {
          send(ws, { t: 'sessions', items: listSessions() });
        } else {
          send(ws, { t: 'error', message: `unknown message type: ${String(t)}` });
        }
      } catch (error) {
        send(ws, { t: 'error', sessionId, message: error instanceof Error ? error.message : 'pty error' });
      }
    });
    ws.on('close', () => detach(ws));
    ws.on('error', () => detach(ws));
  });
}
