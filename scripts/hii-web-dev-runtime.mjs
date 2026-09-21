// SPDX-License-Identifier: LicenseRef-BSL-1.1

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { attachPtyGateway, isLocalRequest } from '../server/pty-gateway.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.HII_WEB_DEV_RUNTIME_PORT || 3043);
const runs = new Map();
const canvasModes = new Set(['build', 'plan', 'browse', 'see', 'show']);

function normalizedMode(input) {
  const mode = String(input.mode || 'build');
  if (!canvasModes.has(mode)) throw new Error(`Unsupported HII canvas mode: ${mode}`);
  return mode;
}

function visibleExternalOutput(tool, output) {
  const limit = tool === 'web_fetch' ? 500 : 8_000;
  const value = String(output || '').trim();
  return value.length > limit ? `${value.slice(0, limit)}\n…source context continues inside the agent` : value;
}

function userMessage(event) {
  const data = event?.data || {};
  const text = (key) => typeof data[key] === 'string' ? data[key] : '';
  if (event?.event === 'tool.started') {
    const target = text('target') || 'working';
    if (text('tool') === 'web_search') return `Searching external context · ${target}`;
    if (text('tool') === 'web_fetch') return `Loading external source · ${target}`;
    return `${text('tool') || 'tool'} · ${target}`;
  }
  if (event?.event === 'tool.result' && data.ok === true && ['web_search', 'web_fetch'].includes(text('tool')) && text('output').trim()) {
    return `External context loaded\n${visibleExternalOutput(text('tool'), text('output'))}`;
  }
  if (event?.event === 'tool.result' && data.ok === false && text('output').trim()) return `Revising after tool error · ${text('output')}`;
  if (['run.blocked', 'run.interrupted', 'budget.exceeded'].includes(event?.event)) return text('message') || text('reason');
  if (event?.event === 'run.finished') return text('summary');
  return '';
}

function hiiBinary() {
  const candidates = [
    process.env.HII_CLI_BIN,
    path.join(repo, 'target/debug/hii'),
    path.join(repo, 'target/release/hii')
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || 'hii';
}

function headers(status = 200) {
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': `http://127.0.0.1:${port - 1}`,
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
      'cache-control': 'no-store'
    }
  };
}

function send(response, value, status = 200) {
  const init = headers(status);
  response.writeHead(init.status, init.headers);
  response.end(JSON.stringify(value));
}

async function body(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1_000_000) throw new Error('development request exceeds 1 MB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(hiiBinary(), args, { cwd: repo, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error((stderr || stdout || `hii exited ${code}`).trim()));
    });
  });
}

async function startAgent(input) {
  const id = `web-${randomUUID()}`;
  const state = { version: 1, runId: id, status: 'started', text: '', receiptPath: undefined };
  runs.set(id, state);
  const mode = normalizedMode(input);
  const readOnly = ['plan', 'browse', 'see'].includes(mode);
  const packId = String(input.contextPackId || '');
  const fingerprint = String(input.contextFingerprint || '');
  if (!packId || !fingerprint) throw new Error('An approved HII ContextPack is required.');
  const pack = JSON.parse(await cli(['context', 'show', packId, '--fingerprint', fingerprint, '--json']));
  if (pack.status !== 'approved' || pack.fingerprint !== fingerprint) {
    throw new Error('The HII ContextPack is not approved at the requested fingerprint.');
  }
  if (pack.intent !== String(input.intent || '') || pack.mode !== mode) {
    throw new Error('The approved ContextPack does not match this intent or mode.');
  }
  const workspaceRoot = String(input.workspaceRoot || repo);
  if (pack.workspaceRoot !== workspaceRoot || pack.spaceId !== String(input.spaceId || 'default')) {
    throw new Error('The approved ContextPack belongs to a different workspace or Space.');
  }
  const requestedIds = [...new Set(Array.isArray(input.contextNodeIds) ? input.contextNodeIds.map(String) : [])].sort();
  const approvedIds = pack.items.filter((item) => item.selected).map((item) => String(item.ref.id).split(':').at(-1)).sort();
  if (JSON.stringify(requestedIds) !== JSON.stringify(approvedIds)) {
    throw new Error('The approved ContextPack does not match the selected canvas objects.');
  }
  const modelContext = await cli(['context', 'show', packId, '--fingerprint', fingerprint, '--render']);
  const args = [
    '--cwd', workspaceRoot,
    'run', '--no-context', '--context-source', `hii-context-pack:${packId}@${fingerprint}`,
    '--jsonl', '--stream', '--autonomy', 'local-full',
    '--authority', readOnly ? 'read-only' : 'workspace'
  ];
  // A declared informational outcome requires a predeclared verification check.
  // Canvas research instead completes from source-tool evidence, which HII marks
  // incidental (not high-trust), while read-only authority still blocks mutation.
  args.push(`${String(input.intent || '')}\n\n${modelContext}`);
  const child = spawn(hiiBinary(), args, { cwd: repo, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let pending = '';
  const appendProgress = (message) => {
    const normalized = String(message || '').trim();
    if (!normalized || state.text.endsWith(normalized)) return;
    state.text = `${state.text}${state.text ? '\n' : ''}${normalized}`.slice(-60_000);
    state.status = 'progress';
  };
  const consume = (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() || '';
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        const data = event.data || {};
        const message = userMessage(event);
        appendProgress(message);
        if (event.event === 'run.finished') {
          state.receiptPath = data.proof;
        }
      } catch {
        // Raw CLI lines remain internal; the browser only receives normalized progress.
      }
    }
  };
  child.stdout.on('data', (chunk) => consume(String(chunk)));
  child.stderr.on('data', () => {});
  child.on('error', (error) => Object.assign(state, { status: 'failed', text: error.message }));
  child.on('close', (code) => {
    state.status = code === 0 ? 'completed' : 'failed';
    if (code !== 0 && !state.text) state.text = `HII stopped with exit ${code ?? 1}.`;
    state.finishedAt = new Date().toISOString();
  });
  return state;
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'OPTIONS') return send(response, {});
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    if (request.method === 'GET' && url.pathname === '/health') {
      return send(response, { ok: true, binary: hiiBinary(), purpose: 'browser hot-reload transport only' });
    }
    if (request.method === 'GET' && url.pathname === '/home') {
      const output = await cli(['home', '--json']);
      return send(response, JSON.parse(output));
    }
    if (request.method === 'GET' && url.pathname.startsWith('/agent/')) {
      const run = runs.get(url.pathname.slice('/agent/'.length));
      return run ? send(response, run) : send(response, { error: 'run not found' }, 404);
    }
    if (request.method === 'GET' && url.pathname.startsWith('/context/')) {
      const id = decodeURIComponent(url.pathname.slice('/context/'.length));
      const output = await cli(['context', 'show', id, '--json']);
      return send(response, JSON.parse(output));
    }
    if (request.method !== 'POST') return send(response, { error: 'not found' }, 404);
    const input = await body(request);
    if (url.pathname === '/agent') {
      if (!String(input.intent || '').trim()) return send(response, { error: 'intent is required' }, 400);
      return send(response, await startAgent(input), 202);
    }
    if (url.pathname === '/context/compile') {
      const args = [
        '--cwd', String(input.workspaceRoot || repo), 'context', 'compile',
        '--space', String(input.spaceId || 'default'), '--mode', normalizedMode(input),
        '--authority', String(input.authority || 'read-only'), '--json'
      ];
      for (const id of Array.isArray(input.selectedObjectIds) ? input.selectedObjectIds : []) {
        args.push('--selection', String(id));
      }
      if (input.budgetTokens) args.push('--budget', String(input.budgetTokens));
      args.push(String(input.intent || ''));
      const output = await cli(args);
      return send(response, JSON.parse(output));
    }
    if (url.pathname === '/context/approve') {
      const args = ['context', 'approve', String(input.packId || ''), String(input.fingerprint || ''), '--json'];
      if (input.approvedBy?.kind === 'service') args.push('--policy');
      const output = await cli(args);
      return send(response, JSON.parse(output));
    }
    if (url.pathname === '/information/capture') {
      const output = await cli(['--cwd', String(input.workspaceRoot || repo), 'info', 'capture', String(input.url || ''), '--json']);
      return send(response, JSON.parse(output));
    }
    if (url.pathname === '/information/find') {
      const args = ['info', 'find', String(input.query || ''), '--limit', String(input.limit || 10), '--json'];
      if (input.web) args.push('--web');
      const output = await cli(args);
      return send(response, JSON.parse(output));
    }
    return send(response, { error: 'not found' }, 404);
  } catch (error) {
    return send(response, { error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

const terminalSockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
attachPtyGateway(terminalSockets);
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
  if (url.pathname !== '/terminal' || !isLocalRequest(request)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  terminalSockets.handleUpgrade(request, socket, head, (webSocket) => {
    terminalSockets.emit('connection', webSocket, request);
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`HII browser-dev transport and PTY ready at http://127.0.0.1:${port} using ${hiiBinary()}\n`);
});
