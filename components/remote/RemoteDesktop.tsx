// SPDX-License-Identifier: LicenseRef-BSL-1.1
'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import styles from './RemoteDesktop.module.css';

type Session = {
  authenticated: boolean;
  handle?: string;
  csrfToken?: string;
};

type Host = {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  online: boolean;
};

type Screen = { x: number; y: number; width: number; height: number; scale: number };

type Quality = { fps: number; quality: number; maxWidth: number };

const QUALITY_PRESETS: Record<string, Quality> = {
  smooth: { fps: 30, quality: 9, maxWidth: 1280 },
  balanced: { fps: 24, quality: 6, maxWidth: 1600 },
  sharp: { fps: 15, quality: 3, maxWidth: 2560 },
};

const BUTTONS = ['left', 'middle', 'right'] as const;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? 'request_failed');
  return payload;
}

export function RemoteDesktop() {
  const [session, setSession] = useState<Session | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [activeHost, setActiveHost] = useState<Host | null>(null);
  const [screen, setScreen] = useState<Screen | null>(null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState<string | null>(null);
  const [issuedToken, setIssuedToken] = useState<{ hostId: string; token: string } | null>(null);
  const [newHostName, setNewHostName] = useState('');
  const [preset, setPreset] = useState<keyof typeof QUALITY_PRESETS>('balanced');
  const [stats, setStats] = useState({ fps: 0, kbps: 0 });
  const [captureKeys, setCaptureKeys] = useState(true);

  const socketRef = useRef<WebSocket | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const frameUrlRef = useRef<string | null>(null);
  const meterRef = useRef({ frames: 0, bytes: 0, since: Date.now() });
  const clickRef = useRef({ time: 0, x: 0, y: 0, count: 0 });

  useEffect(() => {
    api<Session>('/api/auth/session')
      .then(setSession)
      .catch(() => setSession({ authenticated: false }));
  }, []);

  const refreshHosts = useCallback(async () => {
    try {
      const payload = await api<{ hosts: Host[] }>('/api/remote/hosts');
      setHosts(payload.hosts);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, []);

  useEffect(() => {
    if (session?.authenticated) void refreshHosts();
  }, [session?.authenticated, refreshHosts]);

  const send = useCallback((message: unknown) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  const drawFrame = useCallback((blob: Blob) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      if (canvas.width !== image.width || canvas.height !== image.height) {
        canvas.width = image.width;
        canvas.height = image.height;
      }
      canvas.getContext('2d')?.drawImage(image, 0, 0);
      URL.revokeObjectURL(url);
    };
    image.onerror = () => URL.revokeObjectURL(url);
    image.src = url;
    frameUrlRef.current = url;
  }, []);

  const disconnect = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
    setActiveHost(null);
    setScreen(null);
    setStatus('idle');
  }, []);

  const connect = useCallback(
    (host: Host) => {
      disconnect();
      setError(null);
      setStatus('connecting');
      setActiveHost(host);
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(
        `${scheme}://${window.location.host}/api/remote/view?host=${encodeURIComponent(host.id)}`,
      );
      socket.binaryType = 'blob';
      socketRef.current = socket;

      socket.addEventListener('open', () => setStatus('waiting for host'));
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') {
          const blob = event.data as Blob;
          const meter = meterRef.current;
          meter.frames += 1;
          meter.bytes += blob.size;
          const elapsed = Date.now() - meter.since;
          if (elapsed >= 1000) {
            setStats({
              fps: Math.round((meter.frames * 1000) / elapsed),
              kbps: Math.round((meter.bytes * 8) / elapsed),
            });
            meterRef.current = { frames: 0, bytes: 0, since: Date.now() };
          }
          drawFrame(blob);
          return;
        }
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.t === 'hello') {
          setScreen((message.screen as Screen) ?? null);
          setStatus('connected');
        } else if (message.t === 'host-offline') {
          setStatus('host offline');
        } else if (message.t === 'host-online') {
          setStatus('connected');
        } else if (message.t === 'room' && message.hostOnline === false) {
          setStatus('host offline');
        } else if (message.t === 'clipboard' && typeof message.s === 'string') {
          void navigator.clipboard?.writeText(message.s).catch(() => undefined);
        }
      });
      socket.addEventListener('close', (event) => {
        socketRef.current = null;
        setStatus(event.code === 4003 ? 'revoked' : 'disconnected');
      });
      socket.addEventListener('error', () => setError('connection_failed'));
    },
    [disconnect, drawFrame],
  );

  useEffect(() => () => socketRef.current?.close(), []);

  const normalise = useCallback((event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1),
      y: Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1),
    };
  }, []);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const point = normalise(event);
      if (point) send({ t: 'move', ...point });
    },
    [normalise, send],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      event.preventDefault();
      canvasRef.current?.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      const point = normalise(event);
      if (!point) return;
      // Multi-click is reconstructed here so the host can set clickState and
      // native double-click selection works through the relay.
      const now = Date.now();
      const previous = clickRef.current;
      const near = Math.abs(point.x - previous.x) < 0.005 && Math.abs(point.y - previous.y) < 0.005;
      const count = now - previous.time < 400 && near ? Math.min(previous.count + 1, 3) : 1;
      clickRef.current = { time: now, x: point.x, y: point.y, count };
      send({ t: 'down', b: BUTTONS[event.button] ?? 'left', ...point, clicks: count });
    },
    [normalise, send],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      event.preventDefault();
      const point = normalise(event);
      if (!point) return;
      send({
        t: 'up',
        b: BUTTONS[event.button] ?? 'left',
        ...point,
        clicks: clickRef.current.count,
      });
    },
    [normalise, send],
  );

  const onWheel = useCallback(
    (event: ReactWheelEvent<HTMLCanvasElement>) => {
      event.preventDefault();
      // deltaMode 1 is lines and 2 is pages; the host wants pixels either way.
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      send({
        t: 'scroll',
        dx: -event.deltaX * factor,
        dy: -event.deltaY * factor,
      });
    },
    [send],
  );

  useEffect(() => {
    if (!captureKeys || status !== 'connected') return undefined;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && event.shiftKey) return; // shift+esc releases focus
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      event.preventDefault();
      send({
        t: 'key',
        code: event.code,
        down: event.type === 'keydown',
        shift: event.shiftKey,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        meta: event.metaKey,
      });
    };
    window.addEventListener('keydown', handler, { capture: true });
    window.addEventListener('keyup', handler, { capture: true });
    return () => {
      window.removeEventListener('keydown', handler, { capture: true });
      window.removeEventListener('keyup', handler, { capture: true });
    };
  }, [captureKeys, status, send]);

  useEffect(() => {
    if (status !== 'connected') return;
    send({ t: 'quality', ...QUALITY_PRESETS[preset] });
  }, [preset, status, send]);

  const pairHost = useCallback(async () => {
    if (!session?.csrfToken) return;
    try {
      const created = await api<{ hostId: string; token: string }>('/api/remote/hosts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-HII-CSRF': session.csrfToken },
        body: JSON.stringify({ name: newHostName.trim() || 'My Mac' }),
      });
      setIssuedToken(created);
      setNewHostName('');
      await refreshHosts();
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, [session?.csrfToken, newHostName, refreshHosts]);

  const revokeHost = useCallback(
    async (host: Host) => {
      if (!session?.csrfToken) return;
      try {
        await api(`/api/remote/hosts/${host.id}`, {
          method: 'DELETE',
          headers: { 'X-HII-CSRF': session.csrfToken },
        });
        if (activeHost?.id === host.id) disconnect();
        await refreshHosts();
      } catch (cause) {
        setError((cause as Error).message);
      }
    },
    [session?.csrfToken, activeHost?.id, disconnect, refreshHosts],
  );

  const sendClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      send({ t: 'clipboard-set', s: text });
    } catch {
      setError('clipboard_blocked');
    }
  }, [send]);

  const setupCommand = useMemo(
    () =>
      issuedToken
        ? `sh ~/hii/remote/host/install.sh ${issuedToken.token}`
        : null,
    [issuedToken],
  );

  if (session && !session.authenticated) {
    return (
      <main className={styles.gate}>
        <h1>Remote desktop</h1>
        <p>Sign in to your HII account to reach your paired machines.</p>
        <a className={styles.primary} href="/">Sign in</a>
      </main>
    );
  }

  return (
    <main className={styles.shell}>
      <header className={styles.bar}>
        <span className={styles.brand}>HII / Remote</span>
        <span className={styles.status} data-state={status}>{status}</span>
        {activeHost ? <span className={styles.meter}>{stats.fps} fps · {stats.kbps} kbps</span> : null}
        <div className={styles.spacer} />
        {activeHost ? (
          <>
            <select
              className={styles.select}
              value={preset}
              onChange={(event) => setPreset(event.target.value as keyof typeof QUALITY_PRESETS)}
              aria-label="Stream quality"
            >
              <option value="smooth">Smooth</option>
              <option value="balanced">Balanced</option>
              <option value="sharp">Sharp</option>
            </select>
            <button type="button" onClick={() => setCaptureKeys((value) => !value)}>
              {captureKeys ? 'Keys: host' : 'Keys: browser'}
            </button>
            <button type="button" onClick={sendClipboard}>Send clipboard</button>
            <button type="button" onClick={() => send({ t: 'clipboard-get' })}>Get clipboard</button>
            <button type="button" onClick={() => surfaceRef.current?.requestFullscreen?.()}>
              Fullscreen
            </button>
            <button type="button" onClick={disconnect}>Disconnect</button>
          </>
        ) : null}
      </header>

      {error ? <p className={styles.error}>{error}</p> : null}

      {activeHost ? (
        <div className={styles.surface} ref={surfaceRef}>
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            tabIndex={0}
            onPointerMove={onPointerMove}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
            onContextMenu={(event) => event.preventDefault()}
          />
          {screen ? (
            <p className={styles.hint}>
              {activeHost.name} · {screen.width}×{screen.height} · shift+esc releases keyboard
            </p>
          ) : null}
        </div>
      ) : (
        <section className={styles.hosts}>
          <h1>Your machines</h1>
          {hosts.length === 0 ? <p>No machines paired yet.</p> : null}
          <ul>
            {hosts.map((host) => (
              <li key={host.id}>
                <span className={styles.dot} data-online={host.online} />
                <strong>{host.name}</strong>
                <span className={styles.subtle}>
                  {host.online ? 'online' : host.lastSeenAt
                    ? `last seen ${new Date(host.lastSeenAt).toLocaleString()}`
                    : 'never connected'}
                </span>
                <div className={styles.spacer} />
                <button type="button" disabled={!host.online} onClick={() => connect(host)}>
                  Connect
                </button>
                <button type="button" onClick={() => void revokeHost(host)}>Revoke</button>
              </li>
            ))}
          </ul>

          <h2>Pair a machine</h2>
          <div className={styles.pair}>
            <input
              value={newHostName}
              placeholder="Machine name"
              onChange={(event) => setNewHostName(event.target.value)}
            />
            <button type="button" className={styles.primary} onClick={() => void pairHost()}>
              Create pairing token
            </button>
          </div>
          {setupCommand ? (
            <div className={styles.token}>
              <p>Run this once on the machine you want to reach. The token is shown only now.</p>
              <code>{setupCommand}</code>
              <button type="button" onClick={() => navigator.clipboard?.writeText(setupCommand)}>
                Copy
              </button>
            </div>
          ) : null}
        </section>
      )}
    </main>
  );
}
