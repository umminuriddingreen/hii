#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-BSL-1.1
//
// hii-remote-host — the machine side of the HII remote desktop.
//
// Opens an outbound WebSocket to the HII relay, streams the screen as JPEG
// frames, and replays viewer input through the hii-remote-input injector.
// Nothing listens on this machine: the connection is dial-out only.

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { captureFilter, displayIndexForRect, rectFor } from './remote-source.mjs';

const HOME = homedir();
const CONFIG_PATH = process.env.HII_REMOTE_CONFIG ?? join(HOME, '.hii', 'remote', 'host.json');
const INJECTOR = process.env.HII_REMOTE_INPUT ?? join(HOME, '.hii', 'bin', 'hii-remote-input');
const BOUNDARY_HEADER_END = Buffer.from('\r\n\r\n');
/// Frames are dropped rather than queued past this much unsent socket buffer,
/// so a slow viewer link falls behind in latency instead of in memory.
const MAX_BUFFERED_BYTES = 3 * 1024 * 1024;

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`hii-remote-host: no config at ${CONFIG_PATH}`);
    console.error('Pair this machine from https://humaninformationinterface.com/remote first.');
    process.exit(2);
  }
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const ffmpeg = process.env.HII_REMOTE_FFMPEG
    ?? config.ffmpeg
    ?? ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find((path) => existsSync(path))
    ?? 'ffmpeg';
  const hii = process.env.HII_BIN
    ?? config.hii
    ?? ['/opt/homebrew/bin/hii', '/usr/local/bin/hii', join(HOME, '.hii', 'bin', 'hii')].find((path) => existsSync(path))
    ?? 'hii';
  return {
    relay: config.relay ?? 'wss://humaninformationinterface.com/api/remote/host',
    token: config.token,
    fps: Number(config.fps ?? 24),
    quality: Number(config.quality ?? 6),
    maxWidth: Number(config.maxWidth ?? 1600),
    display: Number(config.display ?? 0),
    ffmpeg,
    hii,
    chatCwd: config.chatCwd ?? HOME,
  };
}

function screenDeviceIndex(display, ffmpeg) {
  const probe = spawn(ffmpeg, ['-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
  return new Promise((resolve) => {
    let text = '';
    probe.stderr.on('data', (chunk) => { text += chunk; });
    probe.on('error', () => resolve(null));
    probe.on('close', () => {
      const matches = [...text.matchAll(/\[(\d+)\]\s+Capture screen (\d+)/g)];
      const found = matches.find((m) => Number(m[2]) === display) ?? matches[0];
      resolve(found ? Number(found[1]) : null);
    });
  });
}

function displayGeometry() {
  return new Promise((resolve) => {
    const probe = spawn(INJECTOR, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    let text = '';
    probe.stdout.on('data', (chunk) => { text += chunk; });
    probe.on('close', () => {
      try {
        resolve(JSON.parse(text.trim().split('\n')[0]).displays);
      } catch {
        resolve([]);
      }
    });
    probe.stdin.end('{"t":"displays"}\n');
  });
}

// KeyboardEvent.code -> macOS virtual keycode. Physical codes are used so the
// viewer's own keyboard layout never shifts which key the host receives.
const KEY_CODES = {
  KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyH: 4, KeyG: 5, KeyZ: 6, KeyX: 7, KeyC: 8, KeyV: 9,
  KeyB: 11, KeyQ: 12, KeyW: 13, KeyE: 14, KeyR: 15, KeyY: 16, KeyT: 17,
  Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21, Digit6: 22, Digit5: 23,
  Equal: 24, Digit9: 25, Digit7: 26, Minus: 27, Digit8: 28, Digit0: 29,
  BracketRight: 30, KeyO: 31, KeyU: 32, BracketLeft: 33, KeyI: 34, KeyP: 35,
  Enter: 36, KeyL: 37, KeyJ: 38, Quote: 39, KeyK: 40, Semicolon: 41,
  Backslash: 42, Comma: 43, Slash: 44, KeyN: 45, KeyM: 46, Period: 47,
  Tab: 48, Space: 49, Backquote: 50, Backspace: 51, Escape: 53,
  MetaRight: 54, MetaLeft: 55, ShiftLeft: 56, CapsLock: 57, AltLeft: 58,
  ControlLeft: 59, ShiftRight: 60, AltRight: 61, ControlRight: 62, Fn: 63,
  F17: 64, NumpadDecimal: 65, NumpadMultiply: 67, NumpadAdd: 69, NumLock: 71,
  AudioVolumeUp: 72, AudioVolumeDown: 73, AudioVolumeMute: 74, NumpadDivide: 75,
  NumpadEnter: 76, NumpadSubtract: 78, F18: 79, F19: 80, NumpadEqual: 81,
  Numpad0: 82, Numpad1: 83, Numpad2: 84, Numpad3: 85, Numpad4: 86, Numpad5: 87,
  Numpad6: 88, Numpad7: 89, F20: 90, Numpad8: 91, Numpad9: 92,
  F5: 96, F6: 97, F7: 98, F3: 99, F8: 100, F9: 101, F11: 103, F13: 105, F16: 106,
  F14: 107, F10: 109, ContextMenu: 110, F12: 111, F15: 113, Help: 114, Insert: 114,
  Home: 115, PageUp: 116, Delete: 117, F4: 118, End: 119, F2: 120, PageDown: 121,
  F1: 122, ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
};

const FLAG_SHIFT = 0x00020000;
const FLAG_CONTROL = 0x00040000;
const FLAG_ALT = 0x00080000;
const FLAG_COMMAND = 0x00100000;

function flagsFor(event) {
  let flags = 0;
  if (event.shift) flags |= FLAG_SHIFT;
  if (event.ctrl) flags |= FLAG_CONTROL;
  if (event.alt) flags |= FLAG_ALT;
  if (event.meta) flags |= FLAG_COMMAND;
  return flags;
}

class Injector {
  constructor() {
    this.process = spawn(INJECTOR, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.process.on('exit', (code) => {
      console.error(`hii-remote-input exited (${code}); input is disabled`);
      this.process = null;
    });
    this.pending = '';
    this.onMessage = null;
    this.process.stdout.on('data', (chunk) => {
      this.pending += chunk;
      let index;
      while ((index = this.pending.indexOf('\n')) >= 0) {
        const line = this.pending.slice(0, index);
        this.pending = this.pending.slice(index + 1);
        try {
          const message = JSON.parse(line);
          this.onMessage?.(message);
        } catch { /* injector chatter that is not a command reply */ }
      }
    });
  }

  send(command) {
    if (!this.process) return;
    this.process.stdin.write(`${JSON.stringify(command)}\n`);
  }
}

class Host {
  constructor(config) {
    this.config = config;
    this.injector = new Injector();
    this.socket = null;
    this.ffmpeg = null;
    this.buffer = Buffer.alloc(0);
    this.geometry = [];
    this.windows = [];
    this.selectedWindowId = null;
    this.captureStats = { capturedFrames: 0, sentFrames: 0, droppedFrames: 0 };
    this.chatProcess = null;
    this.chatRequestId = null;
    this.retryDelay = 1000;
    this.injector.onMessage = (message) => {
      if (message.t === 'clip') this.sendJSON({ t: 'clipboard', s: message.s });
      if (message.t === 'windows' && Array.isArray(message.windows)) {
        this.windows = message.windows
          .map((window) => ({ ...window, screen: rectFor(window) }))
          .filter((window) => window.screen);
        this.sendSources();
      }
    };
    this.statsTimer = setInterval(() => {
      this.sendJSON({ t: 'host-stats', ...this.captureStats });
    }, 1000);
  }

  async start() {
    this.geometry = await displayGeometry();
    this.deviceIndex = await screenDeviceIndex(this.config.display, this.config.ffmpeg);
    if (this.deviceIndex === null) {
      console.error('hii-remote-host: no "Capture screen" device; grant Screen Recording to ffmpeg');
      process.exit(3);
    }
    this.connect();
  }

  connect() {
    const url = `${this.config.relay}?token=${encodeURIComponent(this.config.token)}`;
    console.log(`connecting to ${this.config.relay}`);
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.addEventListener('open', () => {
      console.log('relay connected');
      this.retryDelay = 1000;
      this.sendHello();
      this.refreshSources();
      this.startCapture();
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      this.handleControl(event.data);
    });
    // A rejected handshake surfaces as `error` with no `close` on some
    // runtimes, so both paths funnel through one guarded retry.
    let settled = false;
    const retry = (code) => {
      if (settled) return;
      settled = true;
      console.log(`relay closed (${code})`);
      this.stopCapture();
      if (this.socket === socket) this.socket = null;
      // 4003 is an explicit revoke: the pairing is gone, so stop retrying.
      if (code === 4003) {
        console.error('this host was revoked from the account; exiting');
        process.exit(4);
      }
      setTimeout(() => this.connect(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 30000);
    };
    socket.addEventListener('close', (event) => retry(event.code));
    socket.addEventListener('error', () => retry(0));
  }

  sendJSON(value) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(value));
    }
  }

  sendHello() {
    const screen = this.activeScreen();
    this.sendJSON({
      t: 'hello',
      screen,
      source: this.activeSource(),
      displays: this.geometry,
      fps: this.config.fps,
      platform: 'macos',
    });
  }

  activeWindow() {
    return this.windows.find((window) => window.id === this.selectedWindowId) ?? null;
  }

  activeScreen() {
    return this.activeWindow()?.screen
      ?? this.geometry[this.config.display]
      ?? this.geometry[0]
      ?? null;
  }

  activeSource() {
    const window = this.activeWindow();
    return window
      ? { id: `window:${window.id}`, kind: 'application', label: window.title ? `${window.application} — ${window.title}` : window.application, application: window.application, bundleIdentifier: window.bundleIdentifier ?? null }
      : { id: `display:${this.config.display}`, kind: 'display', label: `Display ${this.config.display + 1}` };
  }

  refreshSources() {
    this.injector.send({ t: 'windows' });
  }

  sendSources() {
    const displays = this.geometry.map((screen, index) => ({
      id: `display:${index}`,
      kind: 'display',
      label: `Display ${index + 1}`,
      screen,
    }));
    const windows = this.windows.map((window) => ({
      id: `window:${window.id}`,
      kind: 'application',
      label: window.title ? `${window.application} — ${window.title}` : window.application,
      application: window.application,
      bundleIdentifier: window.bundleIdentifier ?? null,
      screen: window.screen,
    }));
    this.sendJSON({ t: 'sources', sources: [...displays, ...windows], activeSourceId: this.activeSource().id });
  }

  async applySource(sourceId) {
    if (typeof sourceId !== 'string') return;
    if (sourceId.startsWith('display:')) {
      const display = Number(sourceId.slice('display:'.length));
      if (!Number.isInteger(display) || !this.geometry[display]) return;
      this.selectedWindowId = null;
      this.config.display = display;
    } else if (sourceId.startsWith('window:')) {
      const id = Number(sourceId.slice('window:'.length));
      const window = this.windows.find((candidate) => candidate.id === id);
      if (!window) {
        this.refreshSources();
        return;
      }
      this.selectedWindowId = id;
      this.config.display = displayIndexForRect(window.screen, this.geometry, this.config.display);
      this.injector.send({ t: 'focus', pid: window.pid });
    } else {
      return;
    }
    this.deviceIndex = await screenDeviceIndex(this.config.display, this.config.ffmpeg);
    if (this.deviceIndex === null) return;
    this.stopCapture();
    this.startCapture();
    this.sendHello();
    this.sendSources();
  }

  handleControl(text) {
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }
    const screen = this.activeScreen();
    // Viewer coordinates are normalised 0..1 so the client can scale freely.
    const toX = (nx) => Math.round((screen?.x ?? 0) + nx * (screen?.width ?? 0));
    const toY = (ny) => Math.round((screen?.y ?? 0) + ny * (screen?.height ?? 0));

    switch (event.t) {
      case 'viewer-joined':
        this.sendHello();
        this.refreshSources();
        break;
      case 'move':
        this.injector.send({ t: 'move', x: toX(event.x), y: toY(event.y) });
        break;
      case 'down':
      case 'up':
        this.injector.send({
          t: event.t,
          b: event.b ?? 'left',
          x: toX(event.x),
          y: toY(event.y),
          clicks: Math.min(Math.max(event.clicks ?? 1, 1), 3),
        });
        break;
      case 'scroll':
        this.injector.send({
          t: 'scroll',
          dx: Math.max(-600, Math.min(600, Math.round(event.dx ?? 0))),
          dy: Math.max(-600, Math.min(600, Math.round(event.dy ?? 0))),
        });
        break;
      case 'key': {
        const code = KEY_CODES[event.code];
        if (code === undefined) break;
        this.injector.send({ t: 'key', code, down: !!event.down, flags: flagsFor(event) });
        break;
      }
      case 'text':
        if (typeof event.s === 'string' && event.s.length <= 4096) {
          this.injector.send({ t: 'text', s: event.s });
        }
        break;
      case 'clipboard-set':
        if (typeof event.s === 'string' && event.s.length <= 100000) {
          this.injector.send({ t: 'clip', s: event.s });
        }
        break;
      case 'clipboard-get':
        this.injector.send({ t: 'readclip' });
        break;
      case 'quality':
        this.applyQuality(event);
        break;
      case 'source':
        void this.applySource(event.id);
        break;
      case 'sources-refresh':
        this.refreshSources();
        break;
      case 'chat.run':
        this.startChat(event);
        break;
      case 'chat.cancel':
        if (event.requestId === this.chatRequestId) this.stopChat('cancelled');
        break;
      default:
        break;
    }
  }

  startChat(event) {
    const requestId = typeof event.requestId === 'string' ? event.requestId.slice(0, 128) : '';
    const prompt = typeof event.prompt === 'string' ? event.prompt.trim().slice(0, 8000) : '';
    if (!requestId || !prompt) return;
    if (this.chatProcess) {
      this.sendJSON({ t: 'chat.error', requestId, error: 'hii_is_already_answering' });
      return;
    }
    const context = Array.isArray(event.context)
      ? event.context.slice(-10).map((item) => ({
          role: item?.role === 'assistant' ? 'assistant' : 'user',
          text: typeof item?.text === 'string' ? item.text.slice(0, 2000) : '',
        })).filter((item) => item.text)
      : [];
    const transcript = context.length
      ? `${context.map((item) => `${item.role === 'assistant' ? 'HII' : 'Human'}: ${item.text}`).join('\n\n')}\n\nHuman: ${prompt}`.slice(-16000)
      : prompt;
    const args = [
      '--cwd', this.config.chatCwd,
      '--deadline', '120s',
      '--token-budget', '4096',
      'ask', '--jsonl', transcript,
    ];
    const child = spawn(this.config.hii, args, {
      cwd: this.config.chatCwd,
      env: { HOME, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.chatProcess = child;
    this.chatRequestId = requestId;
    let stdout = '';
    let stderr = '';
    this.sendJSON({ t: 'chat.started', requestId, provider: 'local-hii', cwd: this.config.chatCwd });
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      let index;
      while ((index = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, index);
        stdout = stdout.slice(index + 1);
        try {
          const value = JSON.parse(line);
          if (value.event === 'model.delta' && value.data?.channel === 'content' && typeof value.data.text === 'string') {
            this.sendJSON({ t: 'chat.delta', requestId, text: value.data.text });
          } else if (value.event === 'ask.finished') {
            this.sendJSON({ t: 'chat.usage', requestId, ...value.data });
          }
        } catch { /* only HII JSONL answer events are projected */ }
      }
    });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.on('error', (error) => {
      if (this.chatProcess !== child) return;
      this.sendJSON({ t: 'chat.error', requestId, error: error.code === 'ENOENT' ? 'hii_cli_not_installed' : 'hii_chat_failed' });
      this.chatProcess = null;
      this.chatRequestId = null;
    });
    child.on('close', (code) => {
      if (this.chatProcess !== child) return;
      if (code === 0) this.sendJSON({ t: 'chat.done', requestId });
      else this.sendJSON({ t: 'chat.error', requestId, error: stderr.trim() || `hii_exited_${code}` });
      this.chatProcess = null;
      this.chatRequestId = null;
    });
  }

  stopChat(reason) {
    const process_ = this.chatProcess;
    const requestId = this.chatRequestId;
    this.chatProcess = null;
    this.chatRequestId = null;
    process_?.kill('SIGTERM');
    if (requestId) this.sendJSON({ t: 'chat.error', requestId, error: reason });
  }

  applyQuality(event) {
    const fps = Number(event.fps);
    const quality = Number(event.quality);
    const maxWidth = Number(event.maxWidth);
    if (Number.isFinite(fps)) this.config.fps = Math.min(Math.max(fps, 1), 60);
    if (Number.isFinite(quality)) this.config.quality = Math.min(Math.max(quality, 2), 31);
    if (Number.isFinite(maxWidth)) this.config.maxWidth = Math.min(Math.max(maxWidth, 640), 3840);
    this.stopCapture();
    this.startCapture();
    this.sendHello();
  }

  startCapture() {
    if (this.ffmpeg) return;
    const { fps, quality, maxWidth } = this.config;
    const display = this.geometry[this.config.display] ?? this.geometry[0] ?? null;
    const source = this.activeScreen();
    const args = [
      '-loglevel', 'error',
      '-f', 'avfoundation',
      '-capture_cursor', '1',
      '-framerate', String(fps),
      // The screen device only offers packed formats; bgr0 avoids a
      // conversion ffmpeg would otherwise refuse to negotiate.
      '-pix_fmt', 'bgr0',
      '-i', `${this.deviceIndex}:none`,
      // -2 keeps the height even, which mjpeg requires after downscaling.
      '-vf', captureFilter(source, display, maxWidth),
      // AVCaptureScreenInput ignores the input -framerate, so the rate is
      // enforced on the output side instead.
      '-r', String(fps),
      '-c:v', 'mjpeg',
      '-q:v', String(quality),
      // mpjpeg length-prefixes every frame. Scanning for JPEG SOI/EOI markers
      // instead is unsafe: those byte pairs occur inside quantisation and
      // Huffman table payloads, which splits frames at the wrong offset.
      '-f', 'mpjpeg',
      '-',
    ];
    this.ffmpeg = spawn(this.config.ffmpeg, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    this.buffer = Buffer.alloc(0);
    this.ffmpeg.stdout.on('data', (chunk) => this.consume(chunk));
    this.ffmpeg.on('exit', (code) => {
      if (this.ffmpeg) console.error(`ffmpeg exited (${code})`);
      this.ffmpeg = null;
    });
  }

  stopCapture() {
    const process_ = this.ffmpeg;
    this.ffmpeg = null;
    process_?.kill('SIGKILL');
  }

  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf(BOUNDARY_HEADER_END);
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('latin1');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Not a part header we understand; drop it and resynchronise.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      this.captureStats.capturedFrames += 1;
      this.sendFrame(this.buffer.subarray(start, start + length));
      this.buffer = this.buffer.subarray(start + length);
    }
  }

  sendFrame(frame) {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.captureStats.droppedFrames += 1;
      return;
    }
    socket.send(frame);
    this.captureStats.sentFrames += 1;
  }
}

const host = new Host(loadConfig());
host.start().catch((error) => {
  console.error('hii-remote-host failed:', error);
  process.exit(1);
});

// ffmpeg holds the screen capture device exclusively; an orphaned child
// silently blocks every later run, so it is killed on every exit path.
process.on('exit', () => host.stopCapture());
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    host.stopChat('host_stopping');
    host.stopCapture();
    process.exit(0);
  });
}
