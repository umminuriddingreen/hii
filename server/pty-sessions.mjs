import { spawn } from 'node-pty';
import { existsSync } from 'node:fs';
import path from 'path';
import os from 'os';

const ALLOWED_ROOT = path.resolve(os.homedir());
const SCROLLBACK_LIMIT = 2 * 1024 * 1024; // 2MB per session
const EXIT_LINGER_MS = 60_000;

/** @type {Map<string, Session>} */
const sessions = new Map();

/**
 * @typedef {object} Session
 * @property {import('node-pty').IPty | null} pty
 * @property {Buffer[]} scrollback
 * @property {number} scrollbackBytes
 * @property {Set<import('ws').WebSocket>} subscribers
 * @property {string} cwd
 * @property {number} cols
 * @property {number} rows
 * @property {string} createdAt
 * @property {number | null} exitCode
 * @property {'shell' | 'hii'} program
 */

// Server-process secrets (Stripe, Supabase service role, R2, …) must not leak
// into interactive shells; the login shell re-sources the user's own profile,
// so anything the user normally exports comes back on its own.
const SECRET_ENV_PATTERN = /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|API_KEY|ACCESS_KEY|SERVICE_ROLE)/i;

function ptyEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !SECRET_ENV_PATTERN.test(name))
  );
}

function isInside(target) {
  const resolved = path.resolve(target);
  return resolved === ALLOWED_ROOT || resolved.startsWith(`${ALLOWED_ROOT}${path.sep}`);
}

function pushScrollback(session, data) {
  const chunk = Buffer.from(data, 'utf8');
  session.scrollback.push(chunk);
  session.scrollbackBytes += chunk.length;
  while (session.scrollbackBytes > SCROLLBACK_LIMIT && session.scrollback.length > 1) {
    session.scrollbackBytes -= session.scrollback.shift().length;
  }
}

function broadcast(session, message) {
  const payload = JSON.stringify(message);
  for (const ws of session.subscribers) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

export function createSession(sessionId, { cwd, cols, rows, program }) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);
  const safeCwd = cwd && isInside(cwd) ? path.resolve(cwd) : ALLOWED_ROOT;
  const windows = process.platform === 'win32';
  const shell = windows ? (process.env.ComSpec || 'powershell.exe') : (process.env.SHELL || '/bin/zsh');
  const shellArgs = windows && /powershell/i.test(shell) ? ['-NoLogo'] : windows ? [] : ['-l'];
  const hiiCandidate = process.env.HII_BIN
    || (windows ? path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'hii.cmd') : path.join(os.homedir(), 'bin', 'hii'));
  const requestedProgram = program === 'hii' ? 'hii' : 'shell';
  const executable = requestedProgram === 'hii' ? (existsSync(hiiCandidate) ? hiiCandidate : 'hii') : shell;
  const args = requestedProgram === 'hii' ? [] : shellArgs;
  const env = ptyEnv();
  if (requestedProgram === 'hii') {
    // The HUD owns editing and submission. Keep the CLI in its line protocol so
    // a request written while the process is starting remains in the PTY input
    // queue instead of being consumed before crossterm enters raw mode.
    env.HII_UI_LINE_MODE = '1';
  }
  const pty = spawn(executable, args, {
    name: 'xterm-256color',
    cwd: safeCwd,
    cols: Math.max(20, Math.min(500, cols || 80)),
    rows: Math.max(5, Math.min(200, rows || 24)),
    env
  });
  /** @type {Session} */
  const session = {
    pty,
    scrollback: [],
    scrollbackBytes: 0,
    subscribers: new Set(),
    cwd: safeCwd,
    cols: cols || 80,
    rows: rows || 24,
    createdAt: new Date().toISOString(),
    exitCode: null,
    program: requestedProgram
  };
  sessions.set(sessionId, session);

  pty.onData((data) => {
    pushScrollback(session, data);
    broadcast(session, { t: 'data', sessionId, data });
  });
  pty.onExit(({ exitCode }) => {
    session.exitCode = exitCode;
    session.pty = null;
    broadcast(session, { t: 'exit', sessionId, exitCode });
    setTimeout(() => {
      if (sessions.get(sessionId) === session && !session.pty) sessions.delete(sessionId);
    }, EXIT_LINGER_MS).unref?.();
  });

  return session;
}

export function getSession(sessionId) {
  return sessions.get(sessionId) ?? null;
}

export function attach(sessionId, ws) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.subscribers.add(ws);
  return session;
}

export function detach(ws) {
  for (const session of sessions.values()) {
    session.subscribers.delete(ws);
  }
}

export function scrollbackText(session) {
  return Buffer.concat(session.scrollback).toString('utf8');
}

export function write(sessionId, data) {
  const session = sessions.get(sessionId);
  if (session?.pty && typeof data === 'string') session.pty.write(data);
}

export function resize(sessionId, cols, rows) {
  const session = sessions.get(sessionId);
  if (!session?.pty) return;
  const c = Math.max(20, Math.min(500, Math.floor(cols) || session.cols));
  const r = Math.max(5, Math.min(200, Math.floor(rows) || session.rows));
  session.cols = c;
  session.rows = r;
  try {
    session.pty.resize(c, r);
  } catch {
    /* pty may have just exited */
  }
}

export function kill(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  try {
    session.pty?.kill();
  } catch {
    /* already dead */
  }
  sessions.delete(sessionId);
}

export function listSessions() {
  return [...sessions.entries()].map(([id, session]) => ({
    sessionId: id,
    cwd: session.cwd,
    createdAt: session.createdAt,
    alive: session.pty !== null,
    exitCode: session.exitCode,
    subscribers: session.subscribers.size,
    program: session.program
  }));
}
