#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STATE_BEGIN = '<!-- HII_STATE:BEGIN -->';
export const STATE_END = '<!-- HII_STATE:END -->';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readmePath = path.join(root, 'README.md');
const legacyCli = path.join(root, 'scripts', 'hii-cli.mjs');

function run(command, args, { cwd = root, env = process.env, required = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...env, HII_ROOT: cwd },
    encoding: 'utf8',
    timeout: 8_000,
    maxBuffer: 4 * 1024 * 1024
  });
  const ok = result.status === 0 && !result.error;
  if (!ok && required) {
    const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status ?? 'unknown'}`;
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`);
  }
  return { ok, stdout: result.stdout?.trim() || '', stderr: result.stderr?.trim() || '' };
}

function json(result, fallback) {
  if (!result.ok) return fallback;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return fallback;
  }
}

function executablePath(command, env = process.env) {
  const resolver = process.platform === 'win32' ? 'where' : 'which';
  const result = run(resolver, [command], { env });
  const resolved = result.stdout.split(/\r?\n/).find(Boolean);
  if (!result.ok || !resolved) return command;
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function field(text, name) {
  return text.match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'))?.[1]?.trim();
}

function modelLines(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function cloudConfiguration(health) {
  const matches = [...health.matchAll(/^\s*(MISSING|OK|READY|SET)\s+([A-Z][A-Z0-9_]+)\s*$/gm)];
  return {
    configured: matches.filter((match) => match[1] !== 'MISSING').length,
    total: matches.length,
    observed: matches.length > 0
  };
}

export function snapshotFromObservations({
  home,
  version,
  help,
  models,
  presence,
  systems,
  space,
  health,
  resolvedHii
}) {
  const installedModels = modelLines(models);
  const defaultFromList = installedModels.find((line) => /\bdefault\b/i.test(line))?.split(/\s+/)[0];
  const capabilityCounts = (home.capabilities || []).reduce((counts, capability) => {
    counts[capability.status] = (counts[capability.status] || 0) + 1;
    return counts;
  }, {});
  const systemsObserved = Array.isArray(systems?.systems);
  const systemEntries = systemsObserved ? systems.systems : [];
  const modelState = presence?.model?.state || (installedModels.length ? 'available' : 'unavailable');
  const maximumSteps = Number(help.match(/--max-steps[\s\S]{0,180}?\[default:\s*(\d+)\]/i)?.[1] || 0);
  const cloud = cloudConfiguration(health);

  return {
    schemaVersion: 1,
    source: {
      repo: home.identity?.repo || root,
      branch: home.workspace?.branch || 'unknown'
    },
    cli: {
      version: version || 'unavailable',
      path: resolvedHii || 'hii',
      defaultMaximumSteps: maximumSteps
    },
    models: {
      state: modelState,
      installed: installedModels.length,
      default: presence?.model?.configuredModel || defaultFromList || 'unconfigured'
    },
    runtime: {
      path: home.identity?.runtime || path.join(os.homedir(), '.hii'),
      knowledgePresent: Boolean(home.context?.knowledge?.exists),
      indexedSkills: Number(home.context?.skills?.hii?.indexed || 0),
      readyCapabilities: Number(capabilityCounts.ready || 0),
      partialCapabilities: Number(capabilityCounts.partial || 0)
    },
    supervisor: {
      state: presence?.supervisor?.state || 'unavailable',
      liveExecutors: Number(presence?.supervisor?.liveExecutors || 0),
      managedInstances: Number(presence?.supervisor?.managedInstances || 0)
    },
    space: {
      state: field(space, 'state') || 'unavailable',
      detail: field(space, 'detail') || field(space, 'summary') || 'No live Space health detail was returned.'
    },
    systems: {
      observed: systemsObserved,
      entries: systemEntries
        .map((system) => ({
          id: String(system.id || system.host || 'unknown'),
          os: String(system.os || 'unknown'),
          status: String(system.status || 'unknown'),
          transport: String(system.transport || 'unknown')
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
    },
    cloud
  };
}

export function collectReadmeState({ cwd = root, env = process.env, hii = env.HII_BIN || 'hii' } = {}) {
  const home = JSON.parse(execFileSync(process.execPath, [legacyCli, 'home', '--json'], {
    cwd,
    env: { ...env, HII_ROOT: cwd },
    encoding: 'utf8',
    timeout: 8_000,
    maxBuffer: 4 * 1024 * 1024
  }));
  const version = run(hii, ['--version'], { cwd, env, required: true }).stdout;
  const help = run(hii, ['--help'], { cwd, env }).stdout;
  const models = run(hii, ['models'], { cwd, env }).stdout;
  const presence = json(run(hii, ['presence', 'status', '--json'], { cwd, env }), null);
  const systems = json(run(hii, ['systems', 'status', '--json'], { cwd, env }), { systems: [] });
  const space = run(hii, ['space', 'health'], { cwd, env }).stdout;
  const health = run(hii, ['health', '--text'], { cwd, env }).stdout;
  return snapshotFromObservations({
    home,
    version,
    help,
    models,
    presence,
    systems,
    space,
    health,
    resolvedHii: executablePath(hii, env)
  });
}

export function stateFingerprint(snapshot) {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function cell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function code(value) {
  return `\`${String(value).replace(/`/g, "'")}\``;
}

function systemSummary(systems) {
  if (!systems.observed) return 'System enrollment state was not observed';
  if (!systems.entries.length) return 'No enrolled systems reported';
  return systems.entries.map((system) => `${code(system.id)} (${cell(system.os)}): ${code(system.status)}`).join('; ');
}

export function renderStateBlock(snapshot, refreshedAt) {
  const fingerprint = stateFingerprint(snapshot);
  const cloudSummary = snapshot.cloud.observed
    ? `${snapshot.cloud.configured}/${snapshot.cloud.total} required variables present in this process`
    : 'Cloud configuration presence was not reported';
  const rows = [
    ['Source checkout', `${code(snapshot.source.repo)}, branch ${code(snapshot.source.branch)}`, 'This is the active runtime coordinate; historical worktrees are not implied.'],
    ['Installed CLI', `${code(snapshot.cli.version)} at ${code(snapshot.cli.path)}`, snapshot.cli.defaultMaximumSteps ? `Default run ceiling: ${snapshot.cli.defaultMaximumSteps} steps; zero explicitly disables it.` : 'The installed help did not report a default step ceiling.'],
    ['Local models', `${cell(snapshot.models.state)}; ${snapshot.models.installed} installed; default ${code(snapshot.models.default)}`, 'Provider reachability does not prove a specific inference completed.'],
    ['Local HII state', `${code(snapshot.runtime.path)}; knowledge ${snapshot.runtime.knowledgePresent ? 'present' : 'missing'}; ${snapshot.runtime.indexedSkills} indexed skills; ${snapshot.runtime.readyCapabilities} ready + ${snapshot.runtime.partialCapabilities} partial capabilities`, 'Only HII-instrumented work belongs in HII traces and proof.'],
    ['Supervisor', `${code(snapshot.supervisor.state)}; ${snapshot.supervisor.liveExecutors} live executors; ${snapshot.supervisor.managedInstances} managed instances`, 'Stored instance records are not evidence that an executor is alive.'],
    ['macOS Space', `${code(snapshot.space.state)}; ${cell(snapshot.space.detail)}`, 'Native observation and optional AeroSpace workspace control have separate readiness.'],
    ['Enrolled systems', systemSummary(snapshot.systems), 'Enrollment metadata is not authenticated transport or end-to-end execution proof.'],
    ['Cloud-backed flows', cloudSummary, 'Configuration presence never substitutes for an exercised Supabase, R2, Stripe, publish, credit, or exchange flow.']
  ];
  const table = rows.map((row) => `| ${row.map(cell).join(' | ')} |`).join('\n');
  return `${STATE_BEGIN}
<!-- Generated by scripts/hii-readme-state.mjs; state-sha256:${fingerprint}; refreshed:${refreshedAt} -->

This block is generated from HII's machine-readable local state. It is a
development snapshot, not a release or deployment claim.

| Surface | What is alive or present now | Current boundary |
| --- | --- | --- |
${table}

Refresh it manually with \`npm run readme:update\` and verify drift with
\`npm run readme:check\`. \`hii ship\` refreshes it automatically before local
validation and commit.
${STATE_END}`;
}

function currentBlock(readme) {
  const start = readme.indexOf(STATE_BEGIN);
  const end = readme.indexOf(STATE_END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`README.md must contain one ${STATE_BEGIN} / ${STATE_END} block`);
  }
  if (readme.indexOf(STATE_BEGIN, start + STATE_BEGIN.length) >= 0 || readme.indexOf(STATE_END, end + STATE_END.length) >= 0) {
    throw new Error('README.md contains more than one generated HII state block');
  }
  return { start, end: end + STATE_END.length, text: readme.slice(start, end + STATE_END.length) };
}

export function synchronizeReadme(readme, snapshot, { mode = 'write', now = new Date().toISOString() } = {}) {
  const existing = currentBlock(readme);
  const refreshedAt = existing.text.match(/refreshed:([^\s>]+)\s*-->/)?.[1] || now;
  const expectedWithExistingTime = renderStateBlock(snapshot, refreshedAt);
  const matches = existing.text === expectedWithExistingTime;
  if (mode === 'check') {
    if (!matches) throw new Error('README.md live-state block is stale; run `npm run readme:update`');
    return { content: readme, changed: false };
  }
  if (matches) return { content: readme, changed: false };
  const replacement = renderStateBlock(snapshot, now);
  return {
    content: `${readme.slice(0, existing.start)}${replacement}${readme.slice(existing.end)}`,
    changed: true
  };
}

function main() {
  const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--print') ? 'print' : 'write';
  const snapshot = collectReadmeState();
  const readme = readFileSync(readmePath, 'utf8');
  if (mode === 'print') {
    console.log(renderStateBlock(snapshot, new Date().toISOString()));
    return;
  }
  const result = synchronizeReadme(readme, snapshot, { mode });
  if (mode === 'write' && result.changed) writeFileSync(readmePath, result.content);
  console.log(result.changed ? 'README state refreshed.' : 'README state is current.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
