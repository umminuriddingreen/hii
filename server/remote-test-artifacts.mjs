import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { contentType, resolvePublicArtifact } from './remote-test-core.mjs';

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  process.platform === 'win32' && path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.platform === 'win32' && path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.platform === 'win32' && path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  process.platform === 'linux' && '/usr/bin/google-chrome',
  process.platform === 'linux' && '/usr/bin/chromium'
].filter(Boolean);

function cleanDiagnostic(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

function locationSuffix(details = {}) {
  const url = cleanDiagnostic(details.url);
  const line = Number.isInteger(details.lineNumber) ? details.lineNumber + 1 : null;
  const column = Number.isInteger(details.columnNumber) ? details.columnNumber + 1 : null;
  if (!url) return '';
  return ` (${url}${line ? `:${line}` : ''}${column ? `:${column}` : ''})`;
}

export function chromeFailure(message) {
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params?.exceptionDetails ?? {};
    const exception = details.exception ?? {};
    const description = cleanDiagnostic(
      exception.description ?? exception.value ?? details.text ?? 'JavaScript exception'
    );
    return `js: ${description}${locationSuffix(details)}`;
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
    const values = (message.params.args ?? [])
      .map((argument) => cleanDiagnostic(argument.value ?? argument.description))
      .filter(Boolean);
    return `console: ${values.join(' ') || 'console.error'}`;
  }
  if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
    return `console: ${cleanDiagnostic(message.params.entry.text)}`;
  }
  if (message.method === 'Network.loadingFailed' && !message.params?.canceled) {
    return `network: ${cleanDiagnostic(message.params?.errorText ?? 'request failed')}`;
  }
  if (
    message.method === 'Network.responseReceived' &&
    Number(message.params?.response?.status) >= 400
  ) {
    const response = message.params.response;
    return `asset: HTTP ${response.status} ${cleanDiagnostic(response.url)}`;
  }
  return null;
}

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

async function availableLoopbackPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function devtoolsEndpoint(port, child, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let exitCode = null;
  child.once('exit', (code) => { exitCode = code; });
  while (Date.now() < deadline) {
    try {
      const payload = await new Promise((resolve, reject) => {
        const request = http.get(`http://127.0.0.1:${port}/json/version`, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => { body += chunk; });
          response.on('end', () => response.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${response.statusCode}`)));
        });
        request.setTimeout(500, () => request.destroy(new Error('timeout')));
        request.once('error', reject);
      });
      const endpoint = JSON.parse(payload).webSocketDebuggerUrl;
      if (endpoint) return endpoint;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(exitCode === null
    ? 'Chrome DevTools endpoint timeout'
    : `Chrome exited before verification (${exitCode})`);
}

async function stopChrome(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 1500))
  ]);
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 500))
  ]);
}

async function verifyWithChrome(chrome, url, screenshot) {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hii-remote-chrome-'));
  const debuggingPort = await availableLoopbackPort();
  const child = spawn(chrome, [
    '--headless=new',
    '--disable-background-networking',
    '--disable-breakpad',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--no-first-run',
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let endpoint;
  try {
    endpoint = await devtoolsEndpoint(debuggingPort, child);
    const browserWs = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      browserWs.once('open', resolve);
      browserWs.once('error', reject);
    });
    let nextId = 1;
    const pending = new Map();
    const failures = new Set();
    let sessionId;
    browserWs.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
      const failure = chromeFailure(message);
      if (failure) failures.add(failure);
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
    if (navigation.errorText) failures.add(`navigation: ${navigation.errorText}`);
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
          canvases: canvases.map((c) => ({ width: c.width, height: c.height })),
          backgroundColor: (() => {
            const transparent = new Set(['transparent', 'rgba(0, 0, 0, 0)']);
            const body = getComputedStyle(document.body).backgroundColor;
            const root = getComputedStyle(document.documentElement).backgroundColor;
            if (!transparent.has(body)) return body;
            if (!transparent.has(root)) return root;
            return 'rgb(255, 255, 255)';
          })()
        };
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    const dom = evaluated.result?.value ?? {};
    const capture = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await fs.writeFile(screenshot, Buffer.from(capture.data, 'base64'), { mode: 0o600 });
    browserWs.send(JSON.stringify({ id: nextId++, method: 'Browser.close' }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    browserWs.close();
    return {
      ok: failures.size === 0 && dom.childCount > 0 && dom.visible > 0,
      engine: 'chrome-cdp',
      httpStatus: 200,
      failures: [...failures],
      dom,
      screenshot
    };
  } finally {
    await stopChrome(child);
    await fs.rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
