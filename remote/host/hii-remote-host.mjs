#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// hii-remote-host — the machine side of the HII paired-host link.
//
// Opens an outbound WebSocket to the HII relay and answers chat requests by
// running the local `hii` CLI. Nothing listens on this machine: the connection
// is dial-out only, and the relay only ever reaches a host an account paired.
//
// A separately granted browser channel can render an isolated Chromium page.
// It never captures the machine display or accepts general desktop input.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BrowserSession } from './hii-remote-browser.mjs';

const HOME = homedir();
const CONFIG_PATH = process.env.HII_REMOTE_CONFIG ?? join(HOME, '.hii', 'remote', 'host.json');
const PHONE_COMMAND_TIMEOUT_MS = 10_000;

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`hii-remote-host: no config at ${CONFIG_PATH}`);
    console.error('Pair this machine from https://humaninformationinterface.com/remote first.');
    process.exit(2);
  }
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const hii = process.env.HII_BIN
    ?? config.hii
    ?? ['/opt/homebrew/bin/hii', '/usr/local/bin/hii', join(HOME, '.hii', 'bin', 'hii')].find((path) => existsSync(path))
    ?? 'hii';
  return {
    relay: config.relay ?? 'wss://humaninformationinterface.com/api/remote/host',
    token: config.token,
    hii,
    chatCwd: config.chatCwd ?? HOME,
  };
}

class Host {
  constructor(config) {
    this.config = config;
    this.socket = null;
    this.chatProcess = null;
    this.chatRequestId = null;
    this.retryDelay = 1000;
    this.browsers = new Map();
    this.phoneSessions = new Map();
  }

  async start() {
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
      if (this.socket === socket) this.socket = null;
      this.closeBrowsers();
      for (const session of this.phoneSessions.values()) clearInterval(session.timer);
      this.phoneSessions.clear();
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
    this.sendJSON({ t: 'hello', platform: process.platform === 'win32' ? 'windows' : 'macos', capabilities: ['chat', 'isolated-browser'] });
  }

  handleControl(text) {
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }

    switch (event.t) {
      case 'viewer-joined':
        this.sendHello();
        break;
      case 'chat.run':
        this.startChat(event);
        break;
      case 'chat.cancel':
        if (event.requestId === this.chatRequestId) this.stopChat('cancelled');
        break;
      case 'phone.attach':
        this.attachPhone(event).catch(() => this.phoneError(event.handoffId, 'phone_handoff_unavailable'));
        break;
      case 'phone.input':
      case 'phone.cancel':
        this.receivePhone(event).catch(() => this.phoneError(event.handoffId, 'phone_handoff_unavailable', event.requestId));
        break;
      case 'browser.open':
        this.openBrowser(event);
        break;
      case 'browser.navigate':
        this.browsers.get(event.grantId)?.navigate(event.url).catch(() => this.sendJSON({ t: 'browser.error', grantId: event.grantId, error: 'navigation_failed' }));
        break;
      case 'browser.input':
        this.browsers.get(event.grantId)?.input(event).catch(() => {});
        break;
      case 'browser.close':
      case 'browser.revoked':
        this.closeBrowser(event.grantId);
        break;
      default:
        break;
    }
  }

  async runPhone(action, handoffId, input) {
    const hostId = this.config.token.split('.')[0];
    const args = ['phone', action, '--handoff', handoffId, '--host', hostId];
    if (action === 'project') args.push('--after', String(input.after ?? 0));
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.hii, args, { cwd: this.config.chatCwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      let stdout = '';
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(value);
      };
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error('phone command timed out'));
      }, PHONE_COMMAND_TIMEOUT_MS);
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        if (stdout.length > 600_000) {
          child.kill('SIGKILL');
          finish(new Error('phone command output exceeded limit'));
        }
      });
      child.once('error', () => finish(new Error('phone command could not start')));
      child.once('close', (code) => {
        if (code !== 0) return finish(new Error('phone command rejected'));
        try { finish(null, JSON.parse(stdout)); } catch { finish(new Error('phone command returned invalid data')); }
      });
      child.stdin.end(input.body ? JSON.stringify(input.body) : undefined);
    });
  }

  phoneError(handoffId, error, requestId) {
    if (typeof handoffId !== 'string') return;
    this.sendJSON({ t: 'phone.error', handoffId, error, ...(requestId ? { requestId } : {}) });
  }

  async receivePhone(event) {
    const handoffId = typeof event.handoffId === 'string' ? event.handoffId : '';
    const requestId = typeof event.requestId === 'string' ? event.requestId : '';
    const kind = event.t === 'phone.input' ? 'input' : 'cancel';
    try {
      await this.runPhone('receive', handoffId, { body: { requestId, kind, ...(kind === 'input' ? { text: event.text } : {}) } });
      if (kind === 'input') this.sendJSON({ t: 'phone.queued', handoffId, requestId });
      else {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const projection = await this.runPhone('project', handoffId, { after: 0 });
          const match = projection.statuses?.find((status) => status.requestId === requestId && ['cancelled', 'no_active_run'].includes(status.status));
          if (match?.status === 'cancelled') {
            this.sendJSON({ t: 'phone.cancelled', handoffId, requestId });
            return;
          }
          if (match?.status === 'no_active_run') break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        this.phoneError(handoffId, 'phone_cancel_unavailable', requestId);
      }
    } catch {
      this.phoneError(handoffId, 'phone_handoff_unavailable', requestId);
    }
  }

  async attachPhone(event) {
    const handoffId = typeof event.handoffId === 'string' ? event.handoffId : '';
    if (!handoffId) return;
    const previous = this.phoneSessions.get(handoffId);
    if (previous) clearInterval(previous.timer);
    let projection;
    try {
      projection = await this.runPhone('project', handoffId, { after: Number.isSafeInteger(event.afterCursor) ? event.afterCursor : 0 });
    } catch {
      this.phoneError(handoffId, 'phone_handoff_unavailable');
      return;
    }
    const session = { cursor: projection.cursor, statuses: JSON.stringify(projection.statuses), timer: null, handoffId, polling: false };
    session.cancelled = new Set();
    this.phoneSessions.set(handoffId, session);
    this.sendJSON({ t: 'phone.attached', handoffId, expiresAtUnix: projection.expiresAtUnix, cursor: projection.cursor });
    this.sendPhoneProjection('phone.snapshot', projection);
    session.timer = setInterval(() => this.pollPhoneSession(session), 1_000);
  }

  sendPhoneProjection(type, projection) {
    const { handoffId, expiresAtUnix, cursor, messages, activities, statuses } = projection;
    this.sendJSON({ t: type, handoffId, expiresAtUnix, cursor, messages, activities, statuses });
  }

  async pollPhoneSession(session) {
    if (session.polling || this.phoneSessions.get(session.handoffId) !== session) return;
    session.polling = true;
    try {
      const projection = await this.runPhone('project', session.handoffId, { after: session.cursor });
      if (this.phoneSessions.get(session.handoffId) !== session) return;
      const statuses = JSON.stringify(projection.statuses);
      if (projection.cursor !== session.cursor || statuses !== session.statuses) {
        session.cursor = projection.cursor;
        session.statuses = statuses;
        this.sendPhoneProjection('phone.update', projection);
      }
      for (const status of projection.statuses ?? []) {
        if (status.requestId && status.status === 'cancelled' && !session.cancelled.has(status.requestId)) {
          session.cancelled.add(status.requestId);
          this.sendJSON({ t: 'phone.cancelled', handoffId: session.handoffId, requestId: status.requestId });
        }
      }
    } catch {
      if (this.phoneSessions.get(session.handoffId) !== session) return;
      clearInterval(session.timer);
      this.phoneSessions.delete(session.handoffId);
      this.phoneError(session.handoffId, 'phone_handoff_unavailable');
    } finally {
      session.polling = false;
    }
  }

  async openBrowser(event) {
    const grantId = typeof event.grantId === 'string' ? event.grantId : '';
    if (!grantId || this.browsers.has(grantId)) return;
    if (this.browserOpening) {
      this.sendJSON({ t: 'browser.error', grantId, error: 'browser_is_starting' });
      return;
    }
    this.browserOpening = true;
    // One isolated browser session at a time prevents parallel CDP processes
    // sharing the same profile and avoids accidental cross-grant control.
    await this.browserClosing;
    await this.closeBrowsers();
    let browser;
    try {
      browser = new BrowserSession(grantId, (message) => this.sendJSON(message), this.config.token.split('.')[0]);
      this.browsers.set(grantId, browser);
      await browser.open(event.url);
    }
    catch (error) {
      this.sendJSON({ t: 'browser.error', grantId, error: error.message });
      await this.closeBrowser(grantId);
    }
    finally { this.browserOpening = false; }
  }

  async closeBrowser(grantId) {
    const browser = this.browsers.get(grantId);
    if (!browser) return;
    this.browsers.delete(grantId);
    await browser.close();
  }

  async closeBrowsers() {
    const closing = Promise.all([...this.browsers.keys()].map((grantId) => this.closeBrowser(grantId)));
    this.browserClosing = closing;
    await closing;
    if (this.browserClosing === closing) this.browserClosing = null;
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
    const runId = randomUUID();
    const ledgerEnv = {
      HII_RUN_ID: runId,
      HII_SURFACE: 'remote-host',
      HII_EXTERNAL_REQUEST_ID: requestId,
      HII_INTERACTION_ID: requestId,
      HII_AUTHORITY: 'read-only',
      HII_ACTOR: 'operator',
    };
    const child = spawn(this.config.hii, args, {
      cwd: this.config.chatCwd,
      env: process.platform === 'win32'
        ? {
            HOME,
            USERPROFILE: process.env.USERPROFILE ?? HOME,
            APPDATA: process.env.APPDATA ?? '',
            LOCALAPPDATA: process.env.LOCALAPPDATA ?? '',
            SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
            PATH: process.env.PATH ?? '',
            ...ledgerEnv,
          }
        : {
            HOME,
            PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
            ...ledgerEnv,
          },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.chatProcess = child;
    this.chatRequestId = requestId;
    let stdout = '';
    let stderr = '';
    this.sendJSON({ t: 'chat.started', requestId, runId, provider: 'local-hii', cwd: this.config.chatCwd });
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
}

const host = new Host(loadConfig());
host.start().catch((error) => {
  console.error('hii-remote-host failed:', error);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    host.stopChat('host_stopping');
    host.closeBrowsers();
    process.exit(0);
  });
}
