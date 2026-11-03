import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { boundedRun, commandPlan, securityFindings, updateLedger, verifyCode } from './hii-code-check.mjs';
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hii-code-check-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); for (const args of [['init', '-q'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=', 'commit', '--allow-empty', '-qm', 'fixture']]) { const r = spawnSync('git', args, { cwd: root }); assert.equal(r.status, 0, r.stderr?.toString()); } return root; }
test('check commands require explicit consent and confine targets', t => {
  const workspace = fixture(t); fs.writeFileSync(path.join(workspace, 'test.mjs'), '');
  assert.throws(() => commandPlan({ workspace, run: ['node-tests'], files: ['test.mjs'] }), /allow-execution/);
  assert.throws(() => commandPlan({ workspace, run: ['rm'], allowExecution: true }), /unsupported/);
  assert.throws(() => commandPlan({ workspace, run: ['node-tests'], files: ['../escape.mjs'], allowExecution: true }), /relative/);
  const plan = commandPlan({ workspace, run: ['node-tests'], files: ['test.mjs'], allowExecution: true }); assert.deepEqual(plan[0].args, ['--test', 'test.mjs']);
});
test('durable findings deduplicate and skipped checks preserve; actual passing check resolves', () => {
  const finding = { key: 'stable', checkId: 'test:A', category: 'failed' };
  let ledger = updateLedger(null, [{ id: 'test:A', status: 'failed', findings: [finding] }], 'first');
  ledger = updateLedger(ledger, [{ id: 'test:A', status: 'failed', findings: [finding] }], 'second');
  assert.equal(Object.keys(ledger.findings).length, 1); assert.equal(ledger.findings.stable.firstObserved, 'first'); assert.equal(ledger.findings.stable.lastObserved, 'second'); assert.equal(ledger.findings.stable.observations, 2);
  ledger = updateLedger(ledger, [{ id: 'test:A', status: 'skipped' }, { id: 'test:B', status: 'passed' }], 'third'); assert.equal(ledger.findings.stable.status, 'open');
  ledger = updateLedger(ledger, [{ id: 'test:A', status: 'passed' }], 'fourth'); assert.equal(ledger.findings.stable.status, 'resolved'); assert.equal(ledger.findings.stable.resolvedAt, 'fourth');
});
test('heuristics record file/check evidence without secret source content', () => {
  const source = 'ghp_' + 'a'.repeat(30); const diff = `+++ b/tool.js\n@@ -0,0 +8,2 @@\n+const token = '${source}';\n+spawn('x', {shell: true});\n`;
  const findings = securityFindings(diff); assert.equal(findings.length, 2); assert.equal(findings[0].file, 'tool.js'); assert.equal(findings[0].line, 8); assert.ok(!JSON.stringify(findings).includes(source));
});
test('timeout and output cap fail bounded subprocess checks', async () => {
  const timed = await boundedRun(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }); assert.equal(timed.termination, 'timeout');
  const noisy = await boundedRun(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], { maxOutput: 100 }); assert.equal(noisy.termination, 'output-limit'); assert.ok(Buffer.byteLength(noisy.output) <= 100);
});
test('local receipt stays partial when execution skipped; failing and passing same test update durable ledger', async t => {
  const workspace = fixture(t); const stateDir = path.join(workspace, 'state');
  let receipt = await verifyCode({ workspace, stateDir }); assert.equal(receipt.status, 'partial'); assert.ok(fs.existsSync(receipt.receiptPath));
  fs.writeFileSync(path.join(workspace, 'test.mjs'), 'process.exit(3);');
  receipt = await verifyCode({ workspace, stateDir, run: ['node-tests'], files: ['test.mjs'], allowExecution: true }); assert.equal(receipt.status, 'failed'); assert.equal(receipt.openFindings, 1);
  receipt = await verifyCode({ workspace, stateDir }); assert.equal(receipt.openFindings, 1); assert.equal(receipt.status, 'needs-review');
  fs.writeFileSync(path.join(workspace, 'test.mjs'), ''); receipt = await verifyCode({ workspace, stateDir, run: ['node-tests'], files: ['test.mjs'], allowExecution: true }); assert.equal(receipt.status, 'passed'); assert.equal(receipt.openFindings, 0);
});

test('base commit covers committed changes; clean narrow diff never resolves heuristic bug', async t => {
  const workspace = fixture(t); const stateDir = path.join(workspace, 'state');
  const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(workspace, 'changed.js'), "spawn('x', {shell: true});\n");
  for (const args of [['add', 'changed.js'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=', 'commit', '-qm', 'changed']]) assert.equal(spawnSync('git', args, { cwd: workspace }).status, 0);
  let receipt = await verifyCode({ workspace, stateDir, base });
  assert.equal(receipt.coverage.trackedDiff.baseCommit, base); assert.equal(receipt.status, 'needs-review'); assert.equal(receipt.openFindings, 1);
  const heuristic = receipt.checks.find(check => check.name.includes('heuristics')); assert.ok(heuristic.id.endsWith(base));
  receipt = await verifyCode({ workspace, stateDir }); assert.equal(receipt.openFindings, 1); assert.equal(receipt.status, 'needs-review');
  const ledger = JSON.parse(fs.readFileSync(receipt.ledgerPath, 'utf8')); assert.equal(Object.values(ledger.findings)[0].status, 'open');
  await assert.rejects(verifyCode({ workspace, stateDir, base: '--all' }), /bounded Git/);
});
test('heuristic absence does not resolve even the same baseline scope', () => {
  const finding = securityFindings('+++ b/test.js\n@@ -0,0 +1 @@\n+spawn(\"x\", {shell: true});\n', 'security:base')[0];
  let ledger = updateLedger(null, [{ id: 'security:base', status: 'warning', findings: [finding] }]);
  ledger = updateLedger(ledger, [{ id: 'security:base', status: 'passed', findings: [] }]);
  assert.equal(ledger.findings[finding.key].status, 'open');
});
