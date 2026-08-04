import { spawnSync } from 'node:child_process';

const COMMAND_TIMEOUT_MS = 3000;

const NATIVE_OBSERVER_SCRIPT = String.raw`
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
const workspace = $.NSWorkspace.sharedWorkspace;
const active = workspace.frontmostApplication;
const activeApplication = active ? {
  name: ObjC.unwrap(active.localizedName),
  bundleId: ObjC.unwrap(active.bundleIdentifier),
  pid: Number(active.processIdentifier)
} : null;
const applications = [];
const windows = [];
const monitors = [];
const screens = $.NSScreen.screens;
for (let index = 0; index < screens.count; index += 1) {
  const screen = screens.objectAtIndex(index);
  const frame = screen.frame;
  monitors.push({
    index,
    primary: index === 0,
    frame: { x: Number(frame.origin.x), y: Number(frame.origin.y), width: Number(frame.size.width), height: Number(frame.size.height) },
    scaleFactor: Number(screen.backingScaleFactor)
  });
}
const runningApplications = workspace.runningApplications;
for (let index = 0; index < runningApplications.count; index += 1) {
  const process = runningApplications.objectAtIndex(index);
  const name = ObjC.unwrap(process.localizedName);
  if (!name) continue;
  applications.push({
    name,
    bundleId: ObjC.unwrap(process.bundleIdentifier) || '',
    pid: Number(process.processIdentifier),
    frontmost: active ? Number(process.processIdentifier) === Number(active.processIdentifier) : false,
    windows: []
  });
}
const windowInfo = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
for (let index = 0; index < windowInfo.count; index += 1) {
  const window = ObjC.deepUnwrap(windowInfo.objectAtIndex(index));
  if (Number(window.kCGWindowLayer) !== 0) continue;
  const bounds = window.kCGWindowBounds || {};
  const item = {
    appName: window.kCGWindowOwnerName || '',
    pid: Number(window.kCGWindowOwnerPID || 0),
    title: window.kCGWindowName || '',
    position: [Number(bounds.X || 0), Number(bounds.Y || 0)],
    size: [Number(bounds.Width || 0), Number(bounds.Height || 0)],
    windowId: Number(window.kCGWindowNumber || 0)
  };
  windows.push(item);
  const app = applications.find((candidate) => candidate.pid === item.pid);
  if (app) app.windows.push(item);
}
JSON.stringify({ activeApplication, applications, monitors, windows });
`;

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

export function runNativeObserver(options = {}) {
  const result = spawnSync(options.binary || process.env.HII_OSASCRIPT_BIN || 'osascript', ['-l', 'JavaScript', '-e', NATIVE_OBSERVER_SCRIPT], {
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

function observerFailureDetail(result) {
  if (result.timedOut) return 'The native macOS observer did not answer within 3 seconds.';
  return result.stderr || result.error || result.stdout || 'The native macOS observer is unavailable.';
}

export function createSpaceController(run = runAeroSpace, observe = runNativeObserver) {
  function nativeState(status) {
    const result = observe();
    const state = parseJson(result, null);
    if (!state || result.status !== 0) {
      return {
        ok: false,
        health: status,
        backend: 'unavailable',
        observer: { name: 'macOS Window Server', mode: 'read-only', available: false, detail: observerFailureDetail(result) },
        activeApplication: null,
        applications: [],
        windows: []
      };
    }
    return {
      ok: true,
      health: status,
      backend: state.windows?.length ? 'native-macos-observer' : 'native-macos-limited',
      observer: {
        name: 'macOS Window Server',
        mode: 'read-only',
        available: true,
        limitations: state.windows?.length ? [] : ['Window metadata is unavailable; Screen Recording permission may be required.']
      },
      activeApplication: state.activeApplication || null,
      applications: Array.isArray(state.applications) ? state.applications : [],
      monitors: Array.isArray(state.monitors) ? state.monitors : [],
      windows: Array.isArray(state.windows) ? state.windows : []
    };
  }

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
    if (!status.ok) {
      const native = nativeState(status);
      return { ...native, workspaces: [] };
    }
    const monitors = run(['list-monitors', '--json']);
    const workspaces = run(['list-workspaces', '--all', '--json']);
    const windows = run(['list-windows', '--all', '--json']);
    const failed = [monitors, workspaces, windows].find((result) => result.status !== 0);
    if (failed) {
      const changed = { ...status, state: 'attention', summary: 'AeroSpace state changed while HII read the desktop.', detail: failureDetail(failed) };
      const native = nativeState(changed);
      return { ...native, workspaces: [] };
    }
    return {
      ok: true,
      health: status,
      backend: 'aerospace',
      observer: { name: 'AeroSpace', mode: 'read-only', available: true },
      activeApplication: null,
      monitors: parseJson(monitors),
      workspaces: parseJson(workspaces),
      windows: parseJson(windows)
    };
  }

  function apps() {
    const status = health();
    if (!status.ok) {
      const native = nativeState(status);
      return { ...native, apps: native.applications };
    }
    const result = run(['list-apps', '--json']);
    if (result.status === 0) {
      return { ok: true, health: status, backend: 'aerospace', observer: { name: 'AeroSpace', mode: 'read-only', available: true }, activeApplication: null, apps: parseJson(result) };
    }
    const changed = { ...status, state: 'attention', summary: 'HII could not read AeroSpace apps.', detail: failureDetail(result) };
    const native = nativeState(changed);
    return { ...native, apps: native.applications };
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
  write(`observer:   ${snapshot.backend}`);
  if (snapshot.activeApplication) write(`active app: ${snapshot.activeApplication.name}${snapshot.activeApplication.bundleId ? ` (${snapshot.activeApplication.bundleId})` : ''}`);
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
      write(`observer: ${result.backend}`);
      if (result.activeApplication) write(`active app: ${result.activeApplication.name}${result.activeApplication.bundleId ? ` (${result.activeApplication.bundleId})` : ''}`);
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
