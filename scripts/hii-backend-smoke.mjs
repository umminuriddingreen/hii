#!/usr/bin/env node
// Exercise the real CLI against isolated OpenAI and Ollama protocol servers.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const binary = process.argv[2];
if (!binary) throw new Error('usage: node scripts/hii-backend-smoke.mjs /path/to/hii');
const run = promisify(execFile);
const root = mkdtempSync(path.join(tmpdir(), 'hii-backends-'));
const runtime = path.join(root, 'runtime');
const config = path.join(runtime, 'config');
mkdirSync(config, { recursive: true });
// Both stale routes must lose to an explicitly selected backend.
writeFileSync(path.join(config, 'inference.json'), JSON.stringify({
  provider: 'native', endpoint: 'http://127.0.0.1:1', selectedModel: 'stale-model',
  backend: 'native-cuda', profile: 'adaptive'
}));
writeFileSync(path.join(config, 'active-inference.json'), JSON.stringify({
  provider: 'native', protocol: 'openai', endpoint: 'http://127.0.0.1:1', selectedModel: 'stale-model'
}));
const env = { ...process.env, HII_RUNTIME_DIR: runtime };
for (const key of ['HII_MODEL', 'HII_MODEL_URL', 'HII_MODEL_PROVIDER', 'HII_OLLAMA_URL', 'HII_RAPID_MLX_URL', 'HII_MODEL_API_KEY', 'HII_MODEL_API_KEY_FILE']) delete env[key];
const cli = async (...args) => (await run(binary, ['--no-hooks', ...args], {
  env, cwd: root, timeout: 20000, maxBuffer: 2 * 1024 * 1024, windowsHide: true
})).stdout;
const requests = [];
const server = createServer(async (request, response) => {
  if (request.url === '/v1/models') return response.end(JSON.stringify({ data: [{ id: 'openai-model' }] }));
  if (request.url === '/api/tags') return response.end(JSON.stringify({ models: [{ name: 'ollama-model' }] }));
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  requests.push({ route: request.url, model: body.model });
  if (request.url === '/v1/chat/completions') {
    response.setHeader('Content-Type', 'text/event-stream');
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'HII_BACKEND_OK' } }] })}\n\ndata: [DONE]\n\n`);
  } else if (request.url === '/api/chat') {
    response.setHeader('Content-Type', 'application/x-ndjson');
    response.end(JSON.stringify({ message: { role: 'assistant', content: 'HII_BACKEND_OK' }, done: true, eval_count: 1 }) + '\n');
  } else { response.statusCode = 404; response.end('{}'); }
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  for (const protocol of ['openai', 'ollama']) {
    await cli('backend', 'add', protocol, '--url', protocol === 'openai' ? `${endpoint}/v1` : endpoint,
      '--protocol', protocol, '--default-model', `${protocol}-model`);
    await cli('backend', 'use', protocol);
    assert.deepEqual(JSON.parse(await cli('backend', 'test', protocol)).advertisedModels, [`${protocol}-model`]);
    const output = await cli('ask', '--jsonl', 'Return HII_BACKEND_OK.');
    const events = output.trim().split('\n').map(line => JSON.parse(line));
    assert(events.some(event => event.event === 'model.delta' && event.data.text === 'HII_BACKEND_OK'));
    const finished = events.find(event => event.event === 'ask.finished');
    assert.equal(finished.data.model, `${protocol}-model`);
    const proof = JSON.parse(readFileSync(finished.data.proof, 'utf8'));
    assert.equal(proof.model, `${protocol}-model`);
    assert.equal(proof.status, 'completed');
  }
  assert.deepEqual(requests.filter(request => request.model), [
    { route: '/v1/chat/completions', model: 'openai-model' },
    { route: '/api/chat', model: 'ollama-model' }
  ]);
  // An invalid selected backend must fail instead of borrowing another runtime.
  writeFileSync(path.join(config, 'active-openai-backend'), 'missing-backend\n');
  await assert.rejects(cli('ask', 'Return HII_BACKEND_OK.'), /no backend named/);
  console.log(JSON.stringify({ ok: true, protocols: ['openai', 'ollama'], streaming: true, receipts: true, staleRoutesIgnored: true, invalidSelectionFailsClosed: true }));
} finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
