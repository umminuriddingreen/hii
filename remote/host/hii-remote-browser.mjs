// SPDX-License-Identifier: LicenseRef-BSL-1.1
// A dedicated Chromium profile exposes only a page, never the host desktop.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROFILE_ROOT = process.env.HII_REMOTE_BROWSER_PROFILE_ROOT ?? join(homedir(), '.hii', 'remote', 'browser-profiles');
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Helium.app/Contents/MacOS/Helium'].find(existsSync);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeUrl = (value) => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
};

export class BrowserSession {
  constructor(grantId, send, pairedHostId) {
    this.grantId = grantId;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(pairedHostId ?? '')) throw new Error('invalid_paired_host');
    this.pairedHostId = pairedHostId;
    this.send = (message) => send({ grantId, ...message });
    this.nextId = 0;
    this.pending = new Map();
    this.lastFrame = 0;
  }

  async open(url) {
    const target = safeUrl(url);
    if (!target || !CHROME) throw new Error(CHROME ? 'invalid_url' : 'chromium_unavailable');
    mkdirSync(PROFILE_ROOT, { recursive: true, mode: 0o700 });
    this.profile = join(PROFILE_ROOT, this.pairedHostId);
    mkdirSync(this.profile, { recursive: true, mode: 0o700 });
    this.lock = join(this.profile, '.hii-browser.lock');
    this.acquireLock();
    const portFile = join(this.profile, 'DevToolsActivePort');
    let port = await this.livePort(portFile);
    if (!port) {
      this.process = spawn(CHROME, [
        `--user-data-dir=${this.profile}`, '--remote-debugging-port=0',
        '--no-first-run', '--no-default-browser-check',
        '--new-window', 'about:blank',
      ], { stdio: 'ignore' });
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      port = await this.livePort(portFile);
      if (port) break;
      await wait(100);
    }
    if (!port) throw new Error('chromium_start_failed');
    const endpoint = `http://127.0.0.1:${port}`;
    const response = await fetch(`${endpoint}/json/new?about:blank`, { method: 'PUT' });
    if (!response.ok) throw new Error('chromium_target_failed');
    const page = await response.json();
    this.cdp = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this.cdp.addEventListener('open', resolve, { once: true });
      this.cdp.addEventListener('error', reject, { once: true });
    });
    this.cdp.addEventListener('message', ({ data }) => this.onMessage(data));
    this.cdp.addEventListener('close', () => this.send({ t: 'browser.closed' }));
    await this.command('Page.enable');
    await this.command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await this.command('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
    await this.navigate(target);
    this.send({ t: 'browser.started', url: target });
  }

  acquireLock() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.lock, 'wx', 0o600);
        writeFileSync(fd, String(process.pid));
        closeSync(fd);
        this.lockOwned = true;
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const owner = Number(readFileSync(this.lock, 'utf8'));
        if (Number.isSafeInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); throw new Error('browser_profile_in_use'); }
          catch (cause) { if (cause.code !== 'ESRCH') throw cause; }
        }
        rmSync(this.lock, { force: true });
      }
    }
    throw new Error('browser_profile_in_use');
  }

  async livePort(portFile) {
    if (!existsSync(portFile)) return null;
    const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
      return response.ok ? port : null;
    } catch { return null; }
  }

  command(method, params = {}) {
    if (this.cdp?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('browser_closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.cdp.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error('browser_timeout')); }, 10000);
    });
  }

  onMessage(data) {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error('browser_command_failed')) : pending.resolve(message.result);
    }
    if (message.method === 'Page.screencastFrame') {
      const now = Date.now();
      if (now - this.lastFrame > 90 && message.params?.data?.length < 450000) {
        this.lastFrame = now;
        this.send({ t: 'browser.frame', data: message.params.data, metadata: message.params.metadata });
      }
      this.command('Page.screencastFrameAck', { sessionId: message.params.sessionId }).catch(() => {});
    } else if (message.method === 'Page.frameNavigated' && message.params?.frame?.url) {
      this.send({ t: 'browser.location', url: message.params.frame.url });
    }
  }

  async navigate(url) {
    const target = safeUrl(url);
    if (!target) throw new Error('invalid_url');
    await this.command('Page.navigate', { url: target });
  }

  async input(event) {
    const type = event?.event;
    if (['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'].includes(type)) {
      const x = Number(event.x), y = Number(event.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1280 || y > 800) return;
      const params = { type, x, y, button: event.button === 'right' ? 'right' : 'left', clickCount: 1 };
      if (type === 'mouseWheel') { params.deltaX = Number(event.deltaX) || 0; params.deltaY = Number(event.deltaY) || 0; }
      await this.command('Input.dispatchMouseEvent', params);
    } else if (['keyDown', 'keyUp', 'char'].includes(type)) {
      const key = typeof event.key === 'string' ? event.key.slice(0, 64) : '';
      const text = typeof event.text === 'string' ? event.text.slice(0, 16) : '';
      await this.command('Input.dispatchKeyEvent', { type, key, text });
    }
  }

  async close() {
    for (const pending of this.pending.values()) pending.reject(new Error('browser_closed'));
    this.pending.clear();
    this.cdp?.close();
    if (this.process && this.process.exitCode === null) {
      this.process.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => this.process.once('exit', resolve)),
        wait(3000),
      ]);
    }
    if (this.lockOwned) {
      rmSync(this.lock, { force: true });
      this.lockOwned = false;
    }
  }
}
