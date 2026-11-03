// SPDX-License-Identifier: Apache-2.0
// Smoke the built HII CLI with a private disposable queue; never print credentials.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const binary = process.argv[2];
if (!binary) throw new Error('Usage: node smoke.mjs <hii binary>');
const env = { ...process.env, HII_COMPUTE_CLIENT_TOKEN: randomBytes(32).toString('hex'), HII_COMPUTE_WORKER_TOKEN: randomBytes(32).toString('hex') };
const directory = await mkdtemp(path.join(os.tmpdir(), 'hii-compute-smoke-'));
const server = spawn(binary, ['compute', 'serve', '--listen', '127.0.0.1:0', '--state', path.join(directory, 'queue.json')], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let serverLog = '';
server.stderr.on('data', chunk => serverLog += chunk);
const invoke = args => new Promise((resolve, reject) => {
  const child = spawn(binary, ['compute', ...args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  child.on('error', reject);
  child.on('close', code => resolve({ code, stdout, stderr }));
});
try {
  let coordinator;
  for (let i = 0; i < 100; i++) {
    const match = serverLog.match(/listening on (127\.0\.0\.1:\d+)/);
    if (match) { coordinator = `http://${match[1]}`; break; }
    if (server.exitCode !== null) throw new Error(serverLog);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(coordinator, 'server starts');
  assert.equal((await fetch(`${coordinator}/nodes`)).status, 401);
  const submitted = await invoke(['submit', '--coordinator', coordinator, '--model', 'native-smoke', '--prompt', 'Return four', '--max-tokens', '16']);
  assert.equal(submitted.code, 0, submitted.stderr);
  const job = JSON.parse(submitted.stdout);
  const inspected = await invoke(['job', job.id, '--coordinator', coordinator]);
  assert.equal(inspected.code, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).status, 'queued');
  const report = { queueHealthy: true, unauthorizedStatus: 401, cliSubmit: 'queued', cliInspect: 'queued', physicalGpuVerified: false };
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, evidence: directory }, null, 2));
} finally {
  server.kill(); // Only the disposable coordinator created above.
}
