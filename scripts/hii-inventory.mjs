#!/usr/bin/env node
// One evidence projection for CLI help, generated docs, and runtime review.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const binary = process.env.HII_NATIVE_BIN || path.join(root, 'target', 'release', process.platform === 'win32' ? 'hii.exe' : 'hii');

function run(program, args, timeout = 3000) {
  try {
    const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', timeout, env: { ...process.env, HII_ROOT: root } });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch { return null; }
}

function json(program, args, timeout) {
  const raw = run(program, args, timeout);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function exists(file) { try { return fs.existsSync(file); } catch { return false; } }

function installedAppPath() {
  if (process.platform === 'darwin') return '/Applications/HII.app';
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
    const candidates = [
      path.join(localAppData, 'HII', 'hii.exe'),
      path.join(localAppData, 'Programs', 'HII', 'hii.exe')
    ];
    return candidates.find(exists) || candidates[0];
  }
  return '/usr/bin/hii';
}

function featureRegistry() {
  const source = path.join(root, 'docs', 'HII_FEATURE_REGISTRY.yaml');
  const raw = fs.readFileSync(source, 'utf8');
  const entries = [];
  for (const line of raw.split('\n')) {
    const match = line.match(/^\s*- \{ id: ([^,]+), name: ([^,]+), classification: ([^,]+), product: ([^,]+), status: ([^ }]+)/);
    if (!match) continue;
    const [, id, name, classification, product, declaredStatus] = match;
    entries.push({ id, name, classification, product, declaredStatus,
      state: ['later', 'next'].includes(declaredStatus) ? 'planned' : 'in-progress',
      evidence: [{ layer: 'source', path: source, claim: `registry declares ${declaredStatus}; runtime behavior is not inferred` }] });
  }
  return { source, entries };
}

export function buildInventory({ live = true } = {}) {
  const generatedAt = new Date().toISOString();
  const manifest = json(binary, ['tools-manifest'], 5000);
  const features = featureRegistry();
  const home = live ? json(binary, ['home', '--json'], 6000) : null;
  const systems = live ? json(binary, ['systems', 'list', '--json'], 3000) : null;
  const model = live ? json(binary, ['model', 'status', '--json'], 4000) : null;
  const health = live ? json('curl', ['-fsS', '--max-time', '2', 'http://127.0.0.1:11435/health'], 3000) : null;
  const peers = live ? json('tailscale', ['status', '--json'], 3000) : null;
  const network = live ? json(binary, ['network', 'status', '--json'], 3000) : null;
  const archive = live ? json(binary, ['archive', 'status'], 3000) : null;
  const inbox = live ? json(binary, ['agents', 'inbox', '--for', 'hii'], 3000) : null;
  const app = installedAppPath();
  const sourceCommit = run('git', ['rev-parse', '--short', 'HEAD']);
  const commands = (manifest?.commands || []).map(command => ({ ...command,
    state: 'in-progress',
    evidence: [{ layer: 'source', path: path.join(root, 'cli/src/route.rs'), claim: 'registered command route' },
      { layer: 'installed', path: binary, claim: exists(binary) ? 'binary responded with manifest; individual command unverified' : 'binary unavailable' }] }));
  const tools = (manifest?.tools || []).map(tool => ({ ...tool, state: 'in-progress',
    evidence: [{ layer: 'source', path: path.join(root, 'cli/src/acp.rs'), claim: 'declared executor contract; individual runtime behavior unverified' }] }));
  const devices = (systems?.systems || []).map(device => ({ ...device,
    state: device.status === 'ready' ? 'working' : 'in-progress',
    evidence: [{ layer: 'runtime', source: 'hii systems list --json', claim: `enrolled executor reports ${device.status}; enrollment alone is not liveness` }] }));
  const tailscalePeers = Object.values(peers?.Peer || {}).map(peer => ({ host: peer.HostName, online: !!peer.Online,
    addresses: peer.TailscaleIPs || [], evidence: [{ layer: 'live', source: 'tailscale status --json', claim: 'transport presence only; HII executor and app state not inferred' }] }));
  const services = [
    { id: 'native-mlx', state: health?.status === 'healthy' ? 'working' : 'in-progress', endpoint: 'http://127.0.0.1:11435', loadedModel: health?.loaded_model || null,
      evidence: [{ layer: 'live', source: '/health', claim: health?.status === 'healthy' ? 'health endpoint answered' : 'no healthy response' }] },
    { id: 'private-gateway', state: network?.running ? 'working' : 'in-progress', endpoint: network?.bind || null,
      evidence: [{ layer: 'runtime', source: 'hii network status --json', claim: network?.transportTruth || 'status unavailable' }] },
  ];
  return { schemaVersion: 1, kind: 'hii.evidence-inventory', generatedAt,
    source: { root, commit: sourceCommit, featureRegistry: features.source, toolManifest: path.join(root, 'cli/src/acp.rs') },
    installed: { cli: { path: binary, state: exists(binary) && manifest ? 'working' : 'in-progress' },
      app: { path: app, state: 'in-progress', installed: exists(app), evidence: 'filesystem presence only; launch unverified' } },
    workspace: home?.workspace || null, model: model || null,
    archive: archive ? { counts: archive.counts, lastSync: archive.lastSync, sourcesConfigured: {
      chatgpt: archive.sources?.chatgpt?.length || 0, codex: !!archive.sources?.codex } } : null,
    coordination: { hiiInboxCount: inbox?.messages?.length ?? null,
      evidence: 'hii agents inbox --for hii; local mailbox only' },
    commands, tools, features: features.entries, devices, tailscalePeers, services,
    limits: ['Source declarations do not prove installed behavior.', 'Tailscale presence does not prove the HII executor is ready.',
      'A present desktop app is not launch proof.', 'Planned registry entries are not advertised as available actions.'] };
}

export function renderHelp(inventory, { all = false } = {}) {
  const groups = new Map();
  for (const command of inventory.commands) {
    if (!all && command.visibility !== 'core') continue;
    if (!groups.has(command.group)) groups.set(command.group, []);
    groups.get(command.group).push(command);
  }
  const lines = ['HII COMMAND MAP', ''];
  for (const [group, commands] of groups) {
    lines.push(`${group}:`);
    for (const command of commands) lines.push(`  hii ${command.name.padEnd(15)} ${command.description}`);
    lines.push('');
  }
  if (!all) {
    for (const name of ['inventory', 'archive']) {
      const command = inventory.commands.find(item => item.name === name);
      if (command) lines.push(`hii ${name.padEnd(17)} ${command.description}`);
    }
    lines.push('hii agents inbox      inspect local agent handoffs');
    lines.push('hii help --all       complete command list');
  }
  return lines.join('\n').trimEnd();
}

export function renderDocs(inventory) {
  const rows = (items, label) => items.map(item => `| ${item.id || item.name} | ${item.state} | ${label(item).replaceAll('|', '\\|')} |`);
  const lines = [
    '# HII Evidence Inventory', '',
    `Generated: ${inventory.generatedAt}`,
    `Base checkout commit at generation: ${inventory.source.commit || 'unavailable'}`,
    'Regenerate: `node scripts/hii-inventory.mjs --write-docs`', '',
    'A source declaration is an implementation lead. Working means a live or installed probe answered; in-progress means present without end-to-end proof; planned means declared for later.', '',
    '## Installed and live', '', '| Item | State | Evidence |', '| --- | --- | --- |',
    `| CLI binary | ${inventory.installed.cli.state} | ${inventory.installed.cli.path} |`,
    `| Desktop app | ${inventory.installed.app.state} | ${inventory.installed.app.path}; launch unverified |`,
    ...rows(inventory.services, item => `${item.endpoint || 'no endpoint'}; ${item.evidence[0].claim}`), '',
    `Imported conversations: ${(inventory.archive?.counts || []).map(row => `${row.provider} ${row.conversations}`).join(', ') || 'unavailable'}; last sync ${inventory.archive?.lastSync || 'unobserved'}.`, '',
    '## Devices', '', '| Item | State | Evidence |', '| --- | --- | --- |',
    ...rows(inventory.devices, item => `${item.host}; executor ${item.status}`),
    ...rows(inventory.tailscalePeers.map(peer => ({ id: `Tailscale ${peer.host} (${peer.addresses[0] || 'no address'})`, state: peer.online ? 'working' : 'in-progress', ...peer })), () => 'transport only; application unverified'), '',
    '## CLI commands', '', '| Command | State | Evidence |', '| --- | --- | --- |',
    ...rows(inventory.commands, item => `${item.implementation}; ${item.group}; cli/src/route.rs`), '',
    '## Agent tools', '', '| Tool | State | Evidence |', '| --- | --- | --- |',
    ...rows(inventory.tools, item => `${item.reach}; ${item.mutates ? 'mutates' : 'read-only'}; cli/src/acp.rs`), '',
    '## Product features', '', '| Feature | State | Source claim |', '| --- | --- | --- |',
    ...rows(inventory.features, item => `${item.declaredStatus}; ${item.product}; docs/HII_FEATURE_REGISTRY.yaml`), '',
    '## Limits', '', ...inventory.limits.map(limit => `- ${limit}`), ''
  ];
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inventory = buildInventory();
  if (process.argv.includes('--write-docs')) {
    const target = path.join(root, 'docs', 'HII_EVIDENCE_INVENTORY.md');
    fs.writeFileSync(target, renderDocs(inventory));
    console.log(target);
  } else if (process.argv.includes('--help-map')) {
    console.log(renderHelp(inventory));
  } else if (process.argv.includes('--markdown')) {
    console.log(renderDocs(inventory));
  } else {
    console.log(JSON.stringify(inventory, null, 2));
  }
}
