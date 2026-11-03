import { spawn } from 'node:child_process';

const CLI = process.env.HII_CLI || '/Users/example/bin/hii';
const PUBLIC = new URL('./public/', import.meta.url);
const LIMIT = 1024 * 1024;
const READ_TIMEOUT = 15000;
const ACTION_TIMEOUT = 120000;

function runHii(args, { timeoutMs = READ_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLI, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const collect = (target, chunk) => {
      size += chunk.length;
      if (size > LIMIT) {
        child.kill('SIGKILL');
        finish(Object.assign(new Error('HII CLI output exceeded the limit'), { status: 502 }));
        return target;
      }
      return target + chunk.toString('utf8');
    };
    child.stdout.on('data', chunk => { stdout = collect(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = collect(stderr, chunk); });
    child.on('error', error => finish(Object.assign(new Error(`Could not run HII CLI: ${error.message}`), { status: 503 })));
    child.on('close', code => {
      if (code !== 0) return finish(Object.assign(new Error(stderr.trim() || `HII CLI exited with code ${code}`), { status: 502 }));
      finish(null, stdout);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(Object.assign(new Error('HII CLI timed out'), { status: 504 }));
    }, timeoutMs);
  });
}

function validModel(value) {
  return typeof value === 'string' && value.length <= 180 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !value.includes('..') && !value.includes('//') && !value.endsWith('/');
}

function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

async function jsonCommand(runCli, args, options) {
  const output = await runCli(args, options);
  const text = typeof output === 'string' ? output : output?.stdout;
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error('HII CLI returned invalid JSON'), { status: 502 }); }
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw Object.assign(new Error('Request body is too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Expected a JSON request body'), { status: 400 }); }
}

export function createModelConsole({ runCli = runHii } = {}) {
  return async function handleModelConsole(req, res, url) {
    const pathname = url.pathname;
    const assets = {
      '/models': ['models.html', 'text/html; charset=utf-8'],
      '/models.js': ['models.js', 'text/javascript; charset=utf-8'],
      '/models.css': ['models.css', 'text/css; charset=utf-8'],
    };
    if (req.method === 'GET' && assets[pathname]) {
      const [file, type] = assets[pathname];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'" });
      res.end(await import('node:fs/promises').then(fs => fs.readFile(new URL(file, PUBLIC))));
      return true;
    }
    if (req.method === 'GET' && pathname === '/api/models/status') {
      try { send(res, 200, await jsonCommand(runCli, ['model', 'status', '--json'], { timeoutMs: READ_TIMEOUT })); }
      catch (error) { send(res, error.status || 502, { error: error.message }); }
      return true;
    }
    if (req.method === 'GET' && pathname === '/api/models/installed') {
      try { send(res, 200, await jsonCommand(runCli, ['model', 'installed', '--json'], { timeoutMs: READ_TIMEOUT })); }
      catch (error) { send(res, error.status || 502, { error: error.message }); }
      return true;
    }
    if (req.method === 'POST' && ['/api/models/use', '/api/models/start'].includes(pathname)) {
      try {
        const body = await readBody(req);
        if (!validModel(body?.model)) { send(res, 400, { error: 'Invalid model identifier' }); return true; }
        const args = pathname.endsWith('/use')
          ? ['model', 'use', body.model]
          : ['model', 'start', '--model', body.model];
        await runCli(args, { timeoutMs: ACTION_TIMEOUT });
        send(res, 200, { ok: true, action: pathname.endsWith('/use') ? 'use' : 'start', model: body.model });
      } catch (error) { send(res, error.status || 502, { error: error.message }); }
      return true;
    }
    return false;
  };
}

