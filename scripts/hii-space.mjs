import { spawnSync } from 'node:child_process';

const COMMAND_TIMEOUT_MS = 3000;

function clean(value) {
  return String(value || '').trim();
}

export function runAeroSpace(args, options = {}) {
  const result = spawnSync(options.binary || process.env.HII_AEROSPACE_BIN || 'aerospace', args, {
    encoding: 'utf8',
    timeout: options.timeoutMs || COMMAND_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024
  });
  return {
    status: result.status,
    stdout: clean(result.stdout),
    stderr: clean(result.stderr),
    error: result.error?.message || '',
    timedOut: result.error?.code === 'ETIMEDOUT'
  };
}

function parseJson(result, fallback = []) {
  if (result.status !== 0 || !result.stdout) return fallback;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return fallback;
  }
}

function failureDetail(result) {
  if (result.timedOut) return 'AeroSpace did not answer within 3 seconds.';
  return result.stderr || result.error || result.stdout || 'AeroSpace is unavailable.';
}

export function createSpaceController(run = runAeroSpace) {
  function health() {
    const version = run(['--version']);
    if (version.status !== 0) {
      return {
        ok: false,
        state: 'unavailable',
        installed: false,
        running: false,
        version: null,
        summary: 'AeroSpace is not installed or cannot be executed.',
        detail: failureDetail(version),
        nextCommand: 'brew install --cask nikitabobko/tap/aerospace'
      };
    }
    const workspaces = run(['list-workspaces', '--all', '--json']);
    if (workspaces.status !== 0) {
      return {
        ok: false,
        state: workspaces.timedOut ? 'attention' : 'offline',
        installed: true,
        running: false,
        version: version.stdout,
        summary: workspaces.timedOut
          ? 'AeroSpace is installed but its local server did not answer.'
          : 'AeroSpace is installed but its local server is not running.',
        detail: failureDetail(workspaces),
        nextCommand: 'open -a AeroSpace'
      };
    }
    return {
      ok: true,
      state: 'ready',
      installed: true,
      running: true,
      version: version.stdout,
      summary: 'AeroSpace is ready for deterministic HII desktop actions.',
      detail: `${parseJson(workspaces).length} workspaces visible`,
      nextCommand: 'hii space snapshot'
    };
  }

  function snapshot() {
    const status = health();
    if (!status.ok) return { ok: false, health: status, monitors: [], workspaces: [], windows: [] };
    const monitors = run(['list-monitors', '--json']);
    const workspaces = run(['list-workspaces', '--all', '--json']);
    const windows = run(['list-windows', '--all', '--json']);
    const failed = [monitors, workspaces, windows].find((result) => result.status !== 0);
    if (failed) {
      return {
        ok: false,
        health: { ...status, state: 'attention', summary: 'AeroSpace state changed while HII read the desktop.', detail: failureDetail(failed) },
        monitors: [],
        workspaces: [],
        windows: []
      };
    }
    return {
      ok: true,
      health: status,
      monitors: parseJson(monitors),
      workspaces: parseJson(workspaces),
      windows: parseJson(windows)
    };
  }

  function apps() {
    const status = health();
    if (!status.ok) return { ok: false, health: status, apps: [] };
    const result = run(['list-apps', '--json']);
    return result.status === 0
      ? { ok: true, health: status, apps: parseJson(result) }
      : { ok: false, health: { ...status, state: 'attention', summary: 'HII could not read AeroSpace apps.', detail: failureDetail(result) }, apps: [] };
  }

  function action(command, args) {
    const status = health();
    if (!status.ok) return { ok: false, health: status, command, args };
    const result = run([command, ...args]);
    return {
      ok: result.status === 0,
      health: status,
      command,
      args,
      output: result.stdout,
      error: result.status === 0 ? '' : failureDetail(result)
    };
  }

  return { health, snapshot, apps, action };
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function monitorTargetArgs(target) {
  return target === 'next' || target === 'prev' ? [target] : ['--', target];
}

function humanHealth(status, write) {
  write('HII Space');
  write(`state:   ${status.state}`);
  write(`summary: ${status.summary}`);
  if (status.version) write(`version: ${status.version}`);
  if (status.detail) write(`detail:  ${status.detail.split('\n')[0]}`);
  write(`next:    ${status.nextCommand}`);
}

function humanSnapshot(snapshot, write) {
  humanHealth(snapshot.health, write);
  if (!snapshot.ok) return;
  write('');
  write(`monitors:   ${snapshot.monitors.length}`);
  write(`workspaces: ${snapshot.workspaces.length}`);
  write(`windows:    ${snapshot.windows.length}`);
  for (const workspace of snapshot.workspaces) {
    const name = workspace['workspace'] ?? workspace.workspace ?? workspace.name ?? '?';
    const monitor = workspace['monitor-id'] ?? workspace.monitorId ?? '';
    const visible = workspace['workspace-is-visible'] ?? workspace.visible;
    write(`  ${visible ? '●' : '○'} ${name}${monitor === '' ? '' : ` · monitor ${monitor}`}`);
  }
}

export function cmdSpace(args, options = {}) {
  const write = options.write || console.log;
  const writeError = options.writeError || console.error;
  const controller = options.controller || createSpaceController();
  const json = args.includes('--json');
  const positional = args.filter((arg) => arg !== '--json');
  const [subcommand = 'health'] = positional;
  let result;

  if (subcommand === 'health') result = controller.health();
  else if (subcommand === 'snapshot') result = controller.snapshot();
  else if (subcommand === 'apps') result = controller.apps();
  else {
    const target = valueAfter(positional, '--target');
    const name = valueAfter(positional, '--name');
    const id = valueAfter(positional, '--id');
    if (subcommand === 'focus-window' && id) result = controller.action('focus', ['--window-id', id]);
    else if (subcommand === 'switch-workspace' && name) result = controller.action('workspace', ['--', name]);
    else if (subcommand === 'move-window-to-workspace' && name) result = controller.action('move-node-to-workspace', ['--', name]);
    else if (subcommand === 'balance') result = controller.action('balance-sizes', []);
    else if (subcommand === 'focus-monitor' && target) result = controller.action('focus-monitor', monitorTargetArgs(target));
    else if (subcommand === 'move-workspace-to-monitor' && target) result = controller.action('move-workspace-to-monitor', monitorTargetArgs(target));
    else if (subcommand === 'reload-config') result = controller.action('reload-config', []);
    else {
      writeError('usage: hii space <health|snapshot|apps|focus-window --id ID|switch-workspace --name NAME|move-window-to-workspace --name NAME|balance|focus-monitor --target TARGET|move-workspace-to-monitor --target TARGET|reload-config> [--json]');
      return 2;
    }
  }

  if (json) write(JSON.stringify(result, null, 2));
  else if (subcommand === 'health') humanHealth(result, write);
  else if (subcommand === 'snapshot') humanSnapshot(result, write);
  else if (subcommand === 'apps') {
    humanHealth(result.health, write);
    if (result.ok) {
      write('');
      write(`apps: ${result.apps.length}`);
      for (const app of result.apps) write(`  ${app['app-name'] ?? app.name ?? app['app-bundle-id'] ?? 'unknown app'}`);
    }
  } else {
    humanHealth(result.health, write);
    if (result.ok) write(`action:  ${result.command} ${result.args.join(' ')}`.trim());
    else if (result.error) writeError(result.error);
  }
  return result.ok ? 0 : 1;
}
