import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createServer } from 'node:http';
import { createModelConsole } from './model-console.mjs';

const servers = new Set();
async function fixture(runCli) {
  const handle = createModelConsole({ runCli });
  const server = createServer(async (req, res) => {
    const handled = await handle(req, res, new URL(req.url, 'http://localhost'));
    if (!handled) { res.writeHead(404); res.end(); }
  });
  servers.add(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, base: `http://127.0.0.1:${address.port}` };
}
afterEach(async () => {
  await Promise.all([...servers].map(server => new Promise(resolve => server.close(resolve))));
  servers.clear();
});

test('status and installed routes invoke only fixed read-only CLI arguments and parse JSON', async () => {
  const calls = [];
  const { base } = await fixture(async (args, options) => { calls.push([args, options]); return JSON.stringify({ args }); });
  assert.deepEqual(await (await fetch(`${base}/api/models/status`)).json(), { args: ['model', 'status', '--json'] });
  assert.deepEqual(await (await fetch(`${base}/api/models/installed`)).json(), { args: ['model', 'installed', '--json'] });
  assert.deepEqual(calls, [
    [['model', 'status', '--json'], { timeoutMs: 15000 }],
    [['model', 'installed', '--json'], { timeoutMs: 15000 }],
  ]);
});

test('use and start pass a validated model as one argv item without a shell', async () => {
  const calls = [];
  const { base } = await fixture(async (args, options) => { calls.push([args, options]); return ''; });
  const model = 'mlx-community/Qwen3.5-9B-MLX-4bit';
  const use = await fetch(`${base}/api/models/use`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
  const start = await fetch(`${base}/api/models/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
  assert.equal(use.status, 200);
  assert.equal(start.status, 200);
  assert.deepEqual(calls, [
    [['model', 'use', model], { timeoutMs: 120000 }],
    [['model', 'start', '--model', model], { timeoutMs: 120000 }],
  ]);
});

test('rejects malformed or shell-like model identifiers before invoking CLI', async () => {
  let calls = 0;
  const { base } = await fixture(async () => { calls++; return ''; });
  for (const model of ['../secret', 'model;whoami', 'x$(id)', 'a//b', '']) {
    const response = await fetch(`${base}/api/models/use`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
});

test('returns bounded CLI failures as JSON errors', async () => {
  const { base } = await fixture(async () => { throw Object.assign(new Error('runtime unavailable'), { status: 504 }); });
  const response = await fetch(`${base}/api/models/status`);
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: 'runtime unavailable' });
});

test('serves the model page and its static assets', async () => {
  const { base } = await fixture(async () => '');
  const page = await fetch(`${base}/models`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Nothing starts when this page opens/);
  assert.match(html, /value="auto"/);
  assert.match(html, /value="mlx"/);
  assert.match(html, /value="llama\.cpp"/);
  const script = await (await fetch(`${base}/models.js`)).text();
  assert.match(script, /Compatible runtime inferred from file format/);
  assert.doesNotMatch(script, /Ollama|LM Studio/i);
  assert.equal((await fetch(`${base}/models.css`)).status, 200);
});
