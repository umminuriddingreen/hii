#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Deterministic local verification. No model, shell evaluation, inferred commands or network client.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const gitArgs = args => ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', ...args];
export async function boundedRun(command, args, { cwd, timeout = 120000, maxOutput = 65536 } = {}) {
  const started = Date.now(); let saved = ''; let bytes = 0; let termination = null;
  return await new Promise(resolve => {
    const childEnv = { ...process.env, CARGO_NET_OFFLINE: 'true', GIT_TERMINAL_PROMPT: '0' };
    delete childEnv.NODE_TEST_CONTEXT; // A parent Node test runner must not silently disable nested verification.
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false; let terminationTimer;
    const stop = reason => { if (termination) return; termination = reason; try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } terminationTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(null); }, 1000); };
    const timer = setTimeout(() => stop('timeout'), timeout);
    const finish = (code, error) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(terminationTimer); resolve({ code, error: error ? String(error.code || 'spawn-error') : null, termination, bytes, output: saved, outputSha256: hash(saved), durationMs: Date.now() - started }); };
    child.once('error', error => finish(null, error));
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { bytes += data.length; const left = Math.max(0, maxOutput - Buffer.byteLength(saved)); saved += data.subarray(0, left).toString('utf8'); if (bytes > maxOutput) stop('output-limit'); });
    child.once('close', code => finish(code));
  });
}
function checkedPath(workspace, relative) {
  if (!relative || relative.startsWith('-') || relative.includes(':') || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(p => !p || p === '..' || p === '.')) throw new Error('check files must be relative paths within workspace');
  let current = workspace;
  for (const part of relative.split('/')) { current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) throw new Error('symlink check files refused'); }
  if (!fs.statSync(current).isFile()) throw new Error('check target must be a regular file');
  return relative;
}
export function commandPlan({ workspace, run = [], files = [], manifest = 'Cargo.toml', allowExecution = false }) {
  const selected = [...new Set(run)];
  if (selected.length && !allowExecution) throw new Error('--run requires --allow-execution: tests and builds execute repository code');
  return selected.map(name => {
    if (name === 'node-tests' || name === 'node-syntax') {
      if (!files.length) throw new Error(`${name} requires explicit --file targets`);
      const targets = files.map(file => checkedPath(workspace, file));
      if (targets.some(file => !/\.(?:mjs|cjs|js)$/.test(file))) throw new Error('Node checks accept only explicit JS files');
      if (name === 'node-syntax' && targets.length !== 1) throw new Error('node-syntax accepts one explicit file per invocation');
      return { id: `${name}:${hash(JSON.stringify([workspace, targets])).slice(0, 16)}`, name, command: process.execPath, args: name === 'node-tests' ? ['--test', ...targets] : ['--check', targets[0]], targets };
    }
    if (name === 'cargo-test' || name === 'cargo-check') {
      checkedPath(workspace, manifest); if (path.basename(manifest) !== 'Cargo.toml') throw new Error('Cargo check requires Cargo.toml');
      return { id: `${name}:${hash(JSON.stringify([workspace, manifest])).slice(0, 16)}`, name, command: 'cargo', args: [name === 'cargo-test' ? 'test' : 'check', '--offline', '--locked', '--manifest-path', manifest], targets: [manifest] };
    }
    throw new Error(`unsupported check: ${name}`);
  });
}
export function securityFindings(diff, checkId = 'security-added-lines') {
  const findings = []; let file = null; let line = 0;
  for (const text of diff.split('\n')) {
    if (text.startsWith('+++ b/')) { file = text.slice(6); continue; }
    const hunk = text.match(/^@@ .* \+(\d+)/); if (hunk) { line = Number(hunk[1]); continue; }
    if (text.startsWith('+') && !text.startsWith('+++')) {
      const source = text.slice(1); const categories = [];
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,})/.test(source)) categories.push('possible-embedded-credential');
      if (/\bHII_YOLO\s*=\s*["']?1|--yolo\b|chmod\s+(?:-R\s+)?777\b|shell\s*:\s*true/.test(source)) categories.push('permission-or-shell-review');
      if (/(?:bind|listen|host)\s*[:=(]\s*["']?0\.0\.0\.0/.test(source)) categories.push('network-exposure-review');
      for (const category of categories) findings.push({ key: hash(JSON.stringify([checkId, category, file, source.trim()])), checkId, category, file, line, resolutionPolicy: 'explicit-fix-verification-required' });
      line += 1;
    } else if (text.startsWith(' ')) line += 1;
  }
  return findings;
}
export function updateLedger(previous, checks, now = new Date().toISOString()) {
  const ledger = { schemaVersion: 1, kind: 'hii.code-findings', findings: { ...(previous?.findings || {}) } };
  for (const check of checks) {
    if (!['passed', 'failed', 'warning'].includes(check.status)) continue;
    for (const finding of check.findings || []) {
      const old = ledger.findings[finding.key];
      ledger.findings[finding.key] = { ...old, ...finding, status: 'open', evidence: { exitCode: check.exitCode ?? null, termination: check.termination ?? null, outputSha256: check.outputSha256 ?? null }, firstObserved: old?.firstObserved || now, lastObserved: now, observations: (old?.observations || 0) + 1, resolvedAt: null };
    }
    if (check.status === 'passed') for (const [key, finding] of Object.entries(ledger.findings)) {
      if (finding.checkId === check.id && finding.status === 'open' && finding.resolutionPolicy !== 'explicit-fix-verification-required') ledger.findings[key] = { ...finding, status: 'resolved', resolvedAt: now, resolution: 'same check passed; this is not a claim that all code is correct' };
    }
  }
  return ledger;
}
function compact(id, name, result, findings = []) { return { id, name, status: result.code === 0 && !result.error && !result.termination ? 'passed' : 'failed', exitCode: result.code, error: result.error, termination: result.termination, outputBytes: result.bytes, outputSha256: result.outputSha256, durationMs: result.durationMs, findings }; }
function failure(checkId, category, evidence = {}) { return { key: hash(JSON.stringify([checkId, category])), checkId, category, ...evidence }; }
function writeJson(file, value) { const tmp = `${file}.${crypto.randomUUID()}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
export async function verifyCode(options = {}) {
  const workspace = fs.realpathSync(path.resolve(options.workspace || process.cwd()));
  const plan = commandPlan({ ...options, workspace });
  const timeout = options.timeout ?? 120000; if (!Number.isInteger(timeout) || timeout < 100 || timeout > 600000) throw new Error('timeout must be 100..600000 milliseconds');
  const stateDir = path.resolve(options.stateDir || path.join(workspace, '.hii/code-check'));
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(stateDir).isSymbolicLink()) throw new Error('symlink state directory refused');
  const lock = path.join(stateDir, 'lock'); fs.mkdirSync(lock); // Concurrent runs must not erase one another's findings.
  try {
    const checks = [];
    const git = async args => boundedRun('git', gitArgs(args), { cwd: workspace, timeout });
    const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
    const workspaceObservation = { dirty: status.output.length > 0, untrackedPresent: status.output.split('\0').some(record => record.startsWith('?? ')), complete: status.code === 0 && !status.termination && !status.error };
    checks.push(compact('git-status', 'Git workspace observation', status, status.code === 0 && !status.termination ? [] : [failure('git-status', 'observation-failed')]));
    const baseRef = options.base || 'HEAD';
    if (typeof baseRef !== 'string' || baseRef.startsWith('-') || baseRef.length > 256 || /[\x00-\x20]/.test(baseRef)) throw new Error('base must be one bounded Git commit/ref without whitespace');
    const baseResult = await git(['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`]);
    if (baseResult.code !== 0 || baseResult.termination || !/^[a-f0-9]{40,64}$/.test(baseResult.output.trim())) throw new Error('base does not resolve to a Git commit');
    const baseCommit = baseResult.output.trim();
    const whitespaceId = `diff-whitespace:${hash(workspace).slice(0, 16)}:${baseCommit}`;
    const securityId = `security-added-lines:${hash(workspace).slice(0, 16)}:${baseCommit}`;
    const white = await git(['diff', baseCommit, '--check', '--no-ext-diff', '--no-textconv']);
    checks.push(compact(whitespaceId, 'Tracked committed, staged and unstaged whitespace from base', white, white.code === 0 && !white.termination ? [] : [failure(whitespaceId, 'whitespace-check-failed')]));
    const diff = await git(['diff', baseCommit, '--no-ext-diff', '--no-textconv', '--unified=0']);
    if (diff.code === 0 && !diff.termination && !diff.error) {
      const findings = securityFindings(diff.output, securityId);
      checks.push({ id: securityId, name: 'Nonexhaustive added-line security and permission heuristics', status: findings.length ? 'warning' : 'passed', findings, outputSha256: diff.outputSha256, outputBytes: diff.bytes });
    } else checks.push({ ...compact(securityId, 'Added-line heuristic input', diff), status: 'skipped', reason: 'complete diff unavailable; prior findings remain open', findings: [] });
    if (!plan.length) checks.push({ id: 'execution', name: 'Tests and builds', status: 'skipped', reason: 'no explicitly authorized named checks selected', findings: [] });
    for (const item of plan) {
      const result = await boundedRun(item.command, item.args, { cwd: workspace, timeout });
      checks.push({ ...compact(item.id, item.name, result, result.code === 0 && !result.error && !result.termination ? [] : [failure(item.id, 'execution-check-failed', { targets: item.targets })]), targets: item.targets, command: item.name });
    }
    const ledgerPath = path.join(stateDir, 'findings.json');
    const previous = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) : null;
    const ledger = updateLedger(previous, checks); writeJson(ledgerPath, ledger);
    const openFindings = Object.values(ledger.findings).filter(f => f.status === 'open').length;
    const id = crypto.randomUUID(); const receiptPath = path.join(stateDir, `${id}.json`);
    const receipt = { schemaVersion: 1, kind: 'hii.code-check', id, at: new Date().toISOString(), workspace, workspaceObservation, status: checks.some(c => c.status === 'failed') ? 'failed' : checks.some(c => c.status === 'warning') || openFindings > 0 ? 'needs-review' : checks.some(c => c.status === 'skipped') ? 'partial' : 'passed', checks, ledgerPath, receiptPath, openFindings, limits: { timeoutMsPerCheck: timeout, outputBytesPerCheck: 65536 }, coverage: { trackedDiff: { baseRef, baseCommit, scope: 'base commit to working tree, including committed, staged and unstaged changes' }, untracked: 'counted in status output only; content not checked', heuristicSecurity: 'nonexhaustive; no correctness or security guarantee', execution: plan.length ? 'explicit named local checks; Cargo offline; repository tests can themselves perform effects' : 'none', windowsCancellation: 'direct child only; descendant termination is not guaranteed' } };
    writeJson(receiptPath, receipt); return receipt;
  } finally { fs.rmdirSync(lock); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = { run: [], files: [] }; const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) { const arg = args[i]; if (arg === '--allow-execution') options.allowExecution = true; else if (['--workspace', '--state-dir', '--run', '--file', '--manifest', '--timeout-ms', '--base'].includes(arg) && args[i + 1]) { const value = args[++i]; if (arg === '--run') options.run.push(value); else if (arg === '--file') options.files.push(value); else options[({ '--workspace': 'workspace', '--state-dir': 'stateDir', '--manifest': 'manifest', '--timeout-ms': 'timeout', '--base': 'base' })[arg]] = arg === '--timeout-ms' ? Number(value) : value; } else throw new Error('usage: hii-code-check.mjs [--workspace DIR] [--state-dir DIR] [--allow-execution --run node-tests|node-syntax|cargo-test|cargo-check --file FILE] [--manifest Cargo.toml] [--timeout-ms N] [--base COMMIT_OR_REF]'); }
    const receipt = await verifyCode(options); console.log(JSON.stringify(receipt, null, 2)); process.exitCode = ['failed', 'needs-review'].includes(receipt.status) ? 1 : 0;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
