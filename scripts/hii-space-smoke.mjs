import assert from 'node:assert/strict';
import { cmdSpace, createSpaceController } from './hii-space.mjs';

const calls = [];
const readyRun = (args) => {
  calls.push(args);
  const key = args.join(' ');
  if (key === '--version') return { status: 0, stdout: 'AeroSpace 0.19.2', stderr: '', error: '', timedOut: false };
  if (key.startsWith('list-workspaces --all --format ')) return { status: 0, stdout: JSON.stringify([
    { workspace: 'main', 'workspace-is-focused': true, 'workspace-is-visible': true, 'monitor-id': 1, 'monitor-name': 'Studio' },
    { workspace: 'build', 'workspace-is-focused': false, 'workspace-is-visible': false, 'monitor-id': 1, 'monitor-name': 'Studio' }
  ]), stderr: '', error: '', timedOut: false };
  if (key.startsWith('list-monitors --format ')) return { status: 0, stdout: JSON.stringify([{ 'monitor-id': 1, 'monitor-name': 'Studio', 'monitor-is-main': true }]), stderr: '', error: '', timedOut: false };
  if (key.startsWith('list-windows --all --format ')) return { status: 0, stdout: JSON.stringify([{ 'window-id': 42, workspace: 'main', 'monitor-id': 1, 'app-name': 'HII', 'window-title': 'Workspace' }]), stderr: '', error: '', timedOut: false };
  if (key === 'list-apps --json') return { status: 0, stdout: JSON.stringify([{ 'app-name': 'HII' }]), stderr: '', error: '', timedOut: false };
  return { status: 0, stdout: '', stderr: '', error: '', timedOut: false };
};
const ready = createSpaceController(readyRun);

assert.equal(ready.health().state, 'ready');
assert.deepEqual(ready.snapshot().workspaces.map((workspace) => workspace.workspace), ['main', 'build']);
assert.equal(ready.snapshot().windows[0]['window-id'], 42);
assert.equal(ready.snapshot().system.focusedSpaceId, 'main');
assert.equal(ready.snapshot().system.spaces.find((space) => space.id === 'build').empty, true);
assert.equal(ready.snapshot().system.spaces.find((space) => space.id === 'main').windowIds[0], 42);
assert.equal(ready.snapshot().system.mutationAvailable, true);
assert.equal(ready.apps().apps[0]['app-name'], 'HII');
assert.equal(ready.action('focus', ['--window-id', '42']).ok, true);

const offline = createSpaceController((args) => args[0] === '--version'
  ? { status: 0, stdout: 'AeroSpace 0.19.2', stderr: '', error: '', timedOut: false }
  : { status: 2, stdout: '', stderr: "Can't connect to AeroSpace server.", error: '', timedOut: false },
() => ({
  status: 0,
  stdout: JSON.stringify({
    activeApplication: { name: 'HII', bundleId: 'com.hii.app', pid: 42 },
    applications: [{ name: 'HII', bundleId: 'com.hii.app', pid: 42, frontmost: true, windows: [{ title: 'Workspace' }] }],
    monitors: [{ index: 0, primary: true }],
    windows: [{ appName: 'HII', bundleId: 'com.hii.app', pid: 42, title: 'Workspace' }]
  }),
  stderr: '', error: '', timedOut: false
}));
const offlineHealth = offline.health();
assert.equal(offlineHealth.state, 'offline');
assert.equal(offlineHealth.installed, true);
assert.equal(offlineHealth.running, false);
assert.equal(offline.snapshot().backend, 'native-macos-observer');
assert.equal(offline.snapshot().activeApplication.name, 'HII');
assert.equal(offline.snapshot().windows[0].title, 'Workspace');
assert.equal(offline.snapshot().monitors[0].primary, true);
assert.equal(offline.snapshot().system.mutationAvailable, false);
assert.equal(offline.apps().apps[0].name, 'HII');
assert.equal(offline.action('focus', ['--window-id', '42']).ok, false);

const timedOut = createSpaceController((args) => args[0] === '--version'
  ? { status: 0, stdout: 'AeroSpace 0.19.2', stderr: '', error: '', timedOut: false }
  : { status: null, stdout: '', stderr: '', error: 'timed out', timedOut: true });
assert.equal(timedOut.health().state, 'attention');

const output = [];
assert.equal(cmdSpace(['health', '--json'], { controller: offline, write: (line) => output.push(line), writeError: () => {} }), 1);
assert.equal(JSON.parse(output.join('\n')).state, 'offline');
assert.equal(cmdSpace(['focus-window'], { controller: ready, write: () => {}, writeError: () => {} }), 2);
assert.ok(calls.some((args) => args.join(' ') === 'focus --window-id 42'));

console.log('HII Space command smoke');
console.log('status:       ok');
console.log('routing:      deterministic Space command family verified');
console.log('health:       ready, offline, and timeout-safe attention states verified');
console.log('snapshot:     monitors, workspaces, windows, and apps parsed');
console.log('actions:      explicit validated argument forwarding verified');
