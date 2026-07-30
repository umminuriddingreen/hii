import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { WebSocket } from 'ws';
import { MODEL, newSecret, newSessionId, writeJsonAtomic } from './remote-test-core.mjs';
import { startRemoteTestGateway } from './remote-test-gateway.mjs';

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
  throw new Error('a local Chrome-family browser is required for evaluation');
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function stripTerminal(value) {
  return String(value)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

export async function runRemoteEvaluation(options) {
  const prompt = String(options.prompt ?? '').trim();
  if (!prompt) throw new Error('evaluation prompt is required');
  const root = path.resolve(options.root);
  const sessionId = options.sessionId ?? newSessionId();
  const sessionPath = newSecret(24);
  const terminalPort = options.terminalPort ?? await freePort();
  const artifactPort = options.artifactPort ?? await freePort();
  const modelPort = options.modelPort ?? await freePort();
  const model = options.model ?? MODEL;
  const timeoutMs = options.timeoutMs ?? 240_000;
  const chromePath = options.chromePath ?? await installedChrome();
  const stateFile = path.join(root, `${sessionId}-active.json`);
  const gateway = await startRemoteTestGateway({
    root,
    stateFile,
    sessionId,
    sessionPath,
    hiiBinary: path.resolve(options.hiiBinary),
    tailscale: options.tailscale ?? '/usr/local/bin/tailscale',
    terminalPort,
    artifactPort,
    modelPort,
    chromePath,
    artifactOrigin: `http://127.0.0.1:${artifactPort}`,
    model,
    expose: false,
    disconnectGraceMs: timeoutMs + 30_000
  }, { expose: false });

  const startedAt = Date.now();
  let inputAt = null;
  let modelAt = null;
  let actionAt = null;
  let verifiedAt = null;
  let doneAt = null;
  let terminal = '';
  let sent = false;
  let verificationFailure = null;
  let evaluationError = null;
  const socket = new WebSocket(`ws://127.0.0.1:${terminalPort}${gateway.basePath}/ws`);
  try {
    await waitForOpen(socket);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`evaluation timed out after ${timeoutMs} ms`)),
        timeoutMs
      );
      const finish = () => {
        if (!doneAt || !verifiedAt) return;
        clearTimeout(timer);
        resolve();
      };
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'data') {
          terminal = stripTerminal(`${terminal}${message.data}`).slice(-120_000);
          const now = Date.now();
          if (!sent && /What do you want to create\?/.test(terminal)) {
            sent = true;
            inputAt = now;
            socket.send(JSON.stringify({ type: 'input', data: `${prompt}\r` }));
          }
          if (!modelAt && /\bMODEL\b/.test(terminal)) modelAt = now;
          if (!actionAt && /\b(?:BUILDING|CHECKING|VERIFYING|RESEARCHING)\b/.test(terminal)) {
            actionAt = now;
          }
          if (!doneAt && /\bDONE\b/.test(terminal)) doneAt = now;
          finish();
        }
        if (message.type === 'artifact-status' && message.status === 'ready') {
          verifiedAt = Date.now();
          finish();
        }
        if (message.type === 'artifact-status' && message.status === 'failed') {
          verificationFailure = message.message ?? 'browser verification failed';
        }
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once('close', () => {
        if (!doneAt || !verifiedAt) {
          clearTimeout(timer);
          reject(new Error('evaluation connection closed before completion'));
        }
      });
    });
  } catch (error) {
    evaluationError = error;
  }

  try {
    const manifest = JSON.parse(await fs.readFile(gateway.layout.manifest, 'utf8'));
    const report = {
      schema: 'hii.remote-evaluation/1',
      sessionId,
      model,
      prompt,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      completed: Boolean(doneAt && verifiedAt && !evaluationError),
      browserVerified: Boolean(verifiedAt),
      verificationFailure,
      error: evaluationError?.message ?? null,
      timings: {
        promptVisibleMs: inputAt === null ? null : inputAt - startedAt,
        modelStreamMs: inputAt === null || modelAt === null ? null : modelAt - inputAt,
        firstActionMs: inputAt === null || actionAt === null ? null : actionAt - inputAt,
        firstVerifiedArtifactMs: inputAt === null || verifiedAt === null ? null : verifiedAt - inputAt,
        doneMs: inputAt === null || doneAt === null ? null : doneAt - inputAt
      },
      artifact: manifest.artifacts?.filter((artifact) => artifact.verified).at(-1) ?? null,
      evidence: {
        sessionDir: gateway.layout.sessionDir,
        transcript: gateway.layout.transcript,
        manifest: gateway.layout.manifest,
        events: gateway.layout.events
      }
    };
    const reportFile = path.join(gateway.layout.sessionDir, 'evaluation.json');
    await writeJsonAtomic(reportFile, report);
    report.evidence.report = reportFile;
    if (evaluationError) {
      const failure = new Error(`${evaluationError.message}; evidence: ${reportFile}`);
      failure.cause = evaluationError;
      throw failure;
    }
    return report;
  } finally {
    socket.close();
    await gateway.shutdown(evaluationError ? 'evaluation-failed' : 'evaluation-complete');
  }
}
