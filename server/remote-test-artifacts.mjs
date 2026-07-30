import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { contentType, resolvePublicArtifact } from './remote-test-core.mjs';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
];

async function installedChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await fs.access(candidate, fs.constants?.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

async function serveForVerification(publicDir) {
  const server = http.createServer(async (req, res) => {
    if (new URL(req.url, 'http://local').pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    try {
      const file = await resolvePublicArtifact(publicDir, new URL(req.url, 'http://local').pathname);
      res.writeHead(200, {
        'content-type': contentType(file),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      });
      res.end(await fs.readFile(file));
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function verifyWithChrome(chrome, url, screenshot) {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hii-remote-chrome-'));
  const child = spawn(chrome, [
    '--headless=new',
    '--disable-background-networking',
    '--disable-breakpad',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--no-first-run',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let endpoint;
  try {
    endpoint = await new Promise((resolve, reject) => {
      let stderr = '';
      const timeout = setTimeout(() => reject(new Error('Chrome DevTools endpoint timeout')), 10_000);
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      });
      child.once('exit', (code) => reject(new Error(`Chrome exited before verification (${code})`)));
    });
    const browserWs = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      browserWs.once('open', resolve);
      browserWs.once('error', reject);
    });
    let nextId = 1;
    const pending = new Map();
    const failures = [];
    let sessionId;
    browserWs.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
      if (message.method === 'Runtime.exceptionThrown') failures.push(`js: ${message.params?.exceptionDetails?.text ?? 'exception'}`);
      if (message.method === 'Log.entryAdded' && ['error', 'warning'].includes(message.params?.entry?.level)) {
        failures.push(`console: ${message.params.entry.text}`);
      }
      if (message.method === 'Network.loadingFailed') failures.push(`network: ${message.params?.errorText ?? 'request failed'}`);
    });
    const call = (method, params = {}, sid = sessionId) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10_000);
      pending.set(id, (message) => {
        clearTimeout(timeout);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      });
      browserWs.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }));
    });
    const target = await call('Target.createTarget', { url: 'about:blank' }, null);
    const attached = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null);
    sessionId = attached.sessionId;
    await Promise.all([
      call('Page.enable'),
      call('Runtime.enable'),
      call('Network.enable'),
      call('Log.enable')
    ]);
    const navigation = await call('Page.navigate', { url });
    if (navigation.errorText) failures.push(`navigation: ${navigation.errorText}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const evaluated = await call('Runtime.evaluate', {
      expression: `(() => {
        const canvases = [...document.querySelectorAll('canvas')];
        const visible = [...document.body.querySelectorAll('*')].filter((el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 1 && r.height > 1 && s.display !== 'none' && s.visibility !== 'hidden';
        }).length;
        return {
          title: document.title,
          bodyText: document.body.innerText.trim().slice(0, 2000),
          childCount: document.body.children.length,
          visible,
          canvases: canvases.map((c) => ({ width: c.width, height: c.height }))
        };
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    const dom = evaluated.result?.value ?? {};
    const capture = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await fs.writeFile(screenshot, Buffer.from(capture.data, 'base64'), { mode: 0o600 });
    browserWs.close();
    return {
      ok: failures.length === 0 && dom.childCount > 0 && dom.visible > 0,
      engine: 'chrome-cdp',
      httpStatus: 200,
      failures,
      dom,
      screenshot
    };
  } finally {
    child.kill('SIGTERM');
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
}

export async function verifyArtifact({ publicDir, relativePath, artifactsDir, chromePath }) {
  const file = await resolvePublicArtifact(publicDir, relativePath);
  const extension = path.extname(file).toLowerCase();
  await fs.mkdir(artifactsDir, { recursive: true, mode: 0o700 });
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(extension)) {
    const stat = await fs.stat(file);
    return {
      ok: stat.size > 0,
      engine: 'image-file',
      httpStatus: 200,
      failures: [],
      dom: { bytes: stat.size },
      screenshot: file
    };
  }
  if (['.txt', '.md', '.json'].includes(extension)) {
    const body = await fs.readFile(file, 'utf8');
    const screenshot = path.join(artifactsDir, `${path.basename(relativePath, extension)}-${Date.now()}.svg`);
    const escaped = body.replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
    await fs.writeFile(
      screenshot,
      `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="700"><rect width="100%" height="100%" fill="#111"/><foreignObject x="32" y="32" width="1136" height="636"><pre xmlns="http://www.w3.org/1999/xhtml" style="color:#eee;font:18px monospace;white-space:pre-wrap">${escaped.slice(0, 16000)}</pre></foreignObject></svg>`,
      { mode: 0o600 }
    );
    return {
      ok: body.trim().length > 0,
      engine: 'text-file',
      httpStatus: 200,
      failures: [],
      dom: { characters: body.length },
      screenshot
    };
  }
  if (extension !== '.html') throw new Error('unsupported artifact type');
  const screenshot = path.join(artifactsDir, `${path.basename(relativePath, '.html')}-${Date.now()}.png`);
  const server = await serveForVerification(publicDir);
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
  try {
    const chrome = chromePath === false ? null : (chromePath ?? await installedChrome());
    if (!chrome) {
      return {
        ok: false,
        engine: 'chrome-required',
        httpStatus: 200,
        failures: ['A local Chrome-family browser is required to verify HTML artifacts.'],
        dom: {},
        screenshot: null
      };
    }
    return await verifyWithChrome(chrome, url, screenshot);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
