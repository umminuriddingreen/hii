import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WIDTH = 1280;
const HEIGHT = 900;

export type BrowserCommand =
  | { type: 'navigate'; url: string }
  | { type: 'back' | 'forward' | 'reload' }
  | { type: 'click'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'scroll'; deltaX?: number; deltaY: number };

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

class ChromiumSession {
  private child: ChildProcess;
  private socket: WebSocket;
  private userDataDir: string;
  private sessionId = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();

  private constructor(child: ChildProcess, socket: WebSocket, userDataDir: string) {
    this.child = child;
    this.socket = socket;
    this.userDataDir = userDataDir;
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result ?? {});
    });
  }

  static async create(): Promise<ChromiumSession> {
    const userDataDir = await mkdtemp(path.join(tmpdir(), 'hii-chromium-'));
    const executable = process.env.HII_CHROMIUM_PATH || DEFAULT_CHROME;
    const child = spawn(executable, [
      '--headless=new', '--disable-background-networking', '--disable-breakpad',
      '--disable-component-update', '--disable-default-apps', '--disable-sync',
      '--hide-scrollbars', '--no-first-run', '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`, `--window-size=${WIDTH},${HEIGHT}`, 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const endpoint = await new Promise<string>((resolve, reject) => {
      let stderr = '';
      const timer = setTimeout(() => reject(new Error('HII Chromium startup timed out')), 10_000);
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`HII Chromium exited during startup (${code})`)));
    });
    const socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const instance = new ChromiumSession(child, socket, userDataDir);
    const target = await instance.call('Target.createTarget', { url: 'about:blank' }, null);
    const attached = await instance.call('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null);
    instance.sessionId = String(attached.sessionId);
    await Promise.all([instance.call('Page.enable'), instance.call('Runtime.enable')]);
    await instance.call('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    return instance;
  }

  private call(method: string, params: Record<string, unknown> = {}, sessionId: string | null = this.sessionId): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Chromium command timed out: ${method}`)); }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async command(command: BrowserCommand): Promise<void> {
    switch (command.type) {
      case 'navigate': {
        const url = new URL(command.url);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('HII Chromium accepts only http(s) URLs');
        await this.call('Page.navigate', { url: url.toString() });
        await new Promise((resolve) => setTimeout(resolve, 350));
        return;
      }
      case 'back': case 'forward': {
        const history = await this.call('Page.getNavigationHistory');
        const offset = command.type === 'back' ? -1 : 1;
        const entry = history.entries?.[Number(history.currentIndex) + offset];
        if (entry) await this.call('Page.navigateToHistoryEntry', { entryId: entry.id });
        return;
      }
      case 'reload': await this.call('Page.reload'); return;
      case 'click':
        await this.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: command.x, y: command.y, button: 'left', clickCount: 1 });
        await this.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: command.x, y: command.y, button: 'left', clickCount: 1 });
        return;
      case 'type': await this.call('Input.insertText', { text: command.text }); return;
      case 'key':
        await this.call('Input.dispatchKeyEvent', { type: 'keyDown', key: command.key });
        await this.call('Input.dispatchKeyEvent', { type: 'keyUp', key: command.key });
        return;
      case 'scroll':
        await this.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: WIDTH / 2, y: HEIGHT / 2, deltaX: command.deltaX ?? 0, deltaY: command.deltaY });
    }
  }

  async snapshot() {
    const [shot, state] = await Promise.all([
      this.call('Page.captureScreenshot', { format: 'jpeg', quality: 82, captureBeyondViewport: false }),
      this.call('Runtime.evaluate', { expression: `({title:document.title,url:location.href,text:document.body?.innerText?.slice(0,12000)||'',selection:getSelection()?.toString().slice(0,12000)||''})`, returnByValue: true })
    ]);
    return { image: `data:image/jpeg;base64,${shot.data}`, ...(state.result?.value ?? {}), width: WIDTH, height: HEIGHT };
  }

  async close() {
    this.socket.close();
    if (this.child.exitCode === null) this.child.kill('SIGTERM');
    await rm(this.userDataDir, { recursive: true, force: true });
  }
}

const sessions = new Map<string, ChromiumSession>();

export async function chromiumSession(id: string) {
  let session = sessions.get(id);
  if (!session) {
    session = await ChromiumSession.create();
    sessions.set(id, session);
  }
  return session;
}

export async function closeChromiumSession(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  await session.close();
}
