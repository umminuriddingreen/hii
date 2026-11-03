// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  contextProjectState,
  createContextProject,
  resetContextDockDbForTests,
  scanContextProject
} from '../../lib/server/hii-context-dock';
import {
  buildOrientationContract,
  detectAgents,
  readActivationReceipt,
  startActivationRun
} from '../../lib/server/hii-activation';

let directory: string;
let projectRoot: string;

function executable(name: string, body: string, windowsBody = body) {
  const windows = process.platform === 'win32';
  const file = path.join(directory, `${name}${windows ? '.cmd' : ''}`);
  fs.writeFileSync(file, windows ? `@echo off\r\n${windowsBody}\r\n` : `#!/bin/sh\n${body}\n`);
  if (!windows) fs.chmodSync(file, 0o755);
  return file;
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hii-activation-test-'));
  projectRoot = path.join(directory, 'approved-project');
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Activation project\nFounder beta context.\n');
  fs.writeFileSync(path.join(projectRoot, 'src', 'index.ts'), 'export const activated = true;\n');
  process.env.HII_DB_PATH = path.join(directory, 'hii.db');
  process.env.HII_RUNTIME_DIR = path.join(directory, 'runtime');
  process.env.HII_CODEX_BIN = executable('codex-ready', 'echo "codex-cli 1.2.3"', 'echo codex-cli 1.2.3');
  process.env.HII_CLAUDE_BIN = executable('claude-ready', 'echo "claude 4.5.6"', 'echo claude 4.5.6');
  process.env.HII_CODEX_AUTH_PATH = path.join(directory, 'codex-auth.json');
  process.env.HII_CLAUDE_AUTH_PATH = path.join(directory, 'claude-auth.json');
  fs.writeFileSync(process.env.HII_CODEX_AUTH_PATH, '{}\n');
  fs.writeFileSync(process.env.HII_CLAUDE_AUTH_PATH, '{}\n');
});

afterEach(() => {
  resetContextDockDbForTests();
  delete process.env.HII_DB_PATH;
  delete process.env.HII_RUNTIME_DIR;
  delete process.env.HII_CODEX_BIN;
  delete process.env.HII_CLAUDE_BIN;
  delete process.env.HII_OLLAMA_BIN;
  delete process.env.HII_CODEX_AUTH_PATH;
  delete process.env.HII_CLAUDE_AUTH_PATH;
  fs.rmSync(directory, { recursive: true, force: true });
});

function indexedProject() {
  const project = createContextProject({ name: 'Activation project', rootPath: projectRoot, approved: true });
  scanContextProject(project.id);
  const state = contextProjectState(project.id);
  expect(state).not.toBeNull();
  return { project, state: state! };
}

describe('activation contract', () => {
  it('detects credential presence and reports Ollama models without claiming account authentication', async () => {
    process.env.HII_CODEX_BIN = executable('codex-stub', 'echo "codex-cli 1.2.3"', 'echo codex-cli 1.2.3');
    process.env.HII_CLAUDE_BIN = executable('claude-stub', 'echo "claude 4.5.6"', 'echo claude 4.5.6');
    process.env.HII_OLLAMA_BIN = executable(
      'ollama-stub',
      '[ "$1" = "list" ] && printf "NAME ID SIZE MODIFIED\\nqwen3:latest abc 1GB now\\nllama3:latest def 2GB now\\n" || echo "ollama version 0.9.0"',
      'if "%~1"=="list" (\r\n  echo NAME ID SIZE MODIFIED\r\n  echo qwen3:latest abc 1GB now\r\n  echo llama3:latest def 2GB now\r\n) else (\r\n  echo ollama version 0.9.0\r\n)'
    );

    await expect(detectAgents()).resolves.toEqual([
      { id: 'codex', installed: true, authenticated: true, version: 'codex-cli 1.2.3', detail: 'Ready for bounded workspace runs.' },
      { id: 'claude', installed: true, authenticated: true, version: 'claude 4.5.6', detail: 'Ready for bounded workspace runs.' },
      { id: 'ollama', installed: true, authenticated: null, version: 'ollama version 0.9.0', detail: 'qwen3:latest, llama3:latest' }
    ]);
  });

  it('turns installed agents without credentials into an actionable sign-in state', async () => {
    fs.rmSync(process.env.HII_CODEX_AUTH_PATH!);
    fs.rmSync(process.env.HII_CLAUDE_AUTH_PATH!);

    const [codex, claude] = await detectAgents();
    expect(codex).toMatchObject({ id: 'codex', installed: true, authenticated: false });
    expect(codex.detail).toContain('codex login');
    expect(claude).toMatchObject({ id: 'claude', installed: true, authenticated: false });
    expect(claude.detail).toContain('complete sign-in');
  });

  it('builds one bounded orientation and preserves the daemon receipt wording', () => {
    const { state } = indexedProject();
    const prompt = buildOrientationContract({ projectState: state, task: 'Add one verified activation proof.', agent: 'codex' });

    expect(prompt).toContain('Project: Activation project');
    expect(prompt).toContain('- README.md (markdown, md)');
    expect(prompt).toContain('Add one verified activation proof.');
    expect(prompt).toContain(`Work only inside the approved project folder: ${fs.realpathSync(projectRoot)}`);
    expect(prompt).toContain('After meaningful work, record a structured after-work receipt with `hii skill report`.');
    expect(prompt).toContain('Mark repeatable verified work with `--repeatable` to create a draft skill candidate; do not register, publish, sell, or license it yourself.');
  });

  it('queues Codex with the project cwd and persists the activation record', async () => {
    const { project } = indexedProject();
    const started = await startActivationRun({ projectId: project.id, agent: 'codex', task: 'Verify the bounded Codex run.' });

    expect(started.runKind).toBe('codex-exec');
    const activation = JSON.parse(fs.readFileSync(path.join(process.env.HII_RUNTIME_DIR!, 'activations', `${started.activationId}.json`), 'utf8'));
    expect(activation).toMatchObject({ id: started.activationId, projectId: project.id, agent: 'codex', status: 'running' });
    const runFile = fs.readdirSync(path.join(process.env.HII_RUNTIME_DIR!, 'daemon', 'runs')).find((file) => file.endsWith('.json'))!;
    const run = JSON.parse(fs.readFileSync(path.join(process.env.HII_RUNTIME_DIR!, 'daemon', 'runs', runFile), 'utf8'));
    expect(run).toMatchObject({ status: 'queued', coordinate: fs.realpathSync(projectRoot), cwd: fs.realpathSync(projectRoot), activationId: started.activationId });
  });

  it('refuses to start a first task without any approved project sources', async () => {
    const emptyRoot = path.join(directory, 'empty-project');
    fs.mkdirSync(emptyRoot);
    const project = createContextProject({ name: 'Empty project', rootPath: emptyRoot, approved: true });

    await expect(
      startActivationRun({ projectId: project.id, agent: 'codex', task: 'Explain this project.' })
    ).rejects.toThrow('at least one supported file');
  });

  it('appends the frozen Claude intent format', async () => {
    const { project } = indexedProject();
    const started = await startActivationRun({ projectId: project.id, agent: 'claude', task: 'Verify the bounded Claude run.' });

    expect(started.runKind).toBe('claude-spawn');
    const intent = JSON.parse(fs.readFileSync(path.join(process.env.HII_RUNTIME_DIR!, 'daemon', 'intents.jsonl'), 'utf8').trim());
    expect(intent).toMatchObject({
      kind: 'agent.spawn',
      preset: 'partner-onboard',
      cwd: fs.realpathSync(projectRoot),
      activationId: started.activationId,
      source: 'hii.activation'
    });
  });

  it('accepts only a latest CLI receipt newer than activation start', async () => {
    const { project } = indexedProject();
    const started = await startActivationRun({ projectId: project.id, agent: 'codex', task: 'Return a fresh receipt.' });
    const cliRoot = path.join(process.env.HII_RUNTIME_DIR!, 'runs', 'cli');
    const runId = 'test-run';
    const receiptPath = path.join(cliRoot, runId, 'receipt.json');
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(path.join(cliRoot, 'latest'), `${runId}\n`);
    fs.writeFileSync(receiptPath, JSON.stringify({ summary: 'verified' }));
    const old = new Date(new Date(started.startedAt).getTime() - 1000);
    fs.utimesSync(receiptPath, old, old);
    await expect(readActivationReceipt(started.activationId)).resolves.toEqual({ status: 'running', receipt: null });

    const fresh = new Date(new Date(started.startedAt).getTime() + 1000);
    fs.utimesSync(receiptPath, fresh, fresh);
    await expect(readActivationReceipt(started.activationId)).resolves.toEqual({ status: 'completed', receipt: { summary: 'verified' } });
    const activation = JSON.parse(fs.readFileSync(path.join(process.env.HII_RUNTIME_DIR!, 'activations', `${started.activationId}.json`), 'utf8'));
    expect(activation).toMatchObject({ status: 'completed', receiptPath });
  });
});
