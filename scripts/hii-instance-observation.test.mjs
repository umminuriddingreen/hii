import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INSTANCE_MAX_AGE_MS, observeInstances, processIsLive } from './lib/instance-observation.mjs';

const now = Date.parse('2026-09-08T12:00:00Z');
const instance = { id: 'process:42', type: 'process', status: 'running', pid: 42 };
const fixture = (instances = [instance], age = 0) => ({ updatedAt: new Date(now - age).toISOString(), instances });
const options = { now, hostname: 'local-mac', probe: (pid) => pid === 42 ? true : pid === 43 ? false : null };

test('fresh local reports distinguish live, dead, and unverified processes', () => {
  const records = observeInstances(fixture([
    instance, { ...instance, pid: 43 }, { ...instance, pid: null },
    { ...instance, status: 'completed' }, null,
  ]), options);
  assert.deepEqual(records.map(({ live, observation }) => [live, observation]), [
    [true, 'live'], [false, 'dead'], [null, 'unknown'],
  ]);
});

test('expired, missing, invalid, or future publication times never probe a reused PID', () => {
  for (const document of [fixture(undefined, INSTANCE_MAX_AGE_MS + 1),
    { instances: [instance] }, { ...fixture(), updatedAt: 'invalid' }, fixture(undefined, -1)]) {
    const [record] = observeInstances(document, { ...options, probe: () => assert.fail('stale PID probed') });
    assert.equal(record.observation, 'stale');
    assert.equal(record.live, null);
  }
});

test('remote or unidentified machine reports never probe local PIDs', () => {
  for (const identity of [{ host: 'remote-pc' }, { hostname: 'remote-pc' }, { remote: true },
    { machine: 'pc' }, { machineId: 'pc' }, { deviceId: 'pc' }]) {
    for (const document of [fixture([{ ...instance, ...identity }]), { ...fixture(), ...identity }]) {
      const [record] = observeInstances(document, { ...options, probe: () => assert.fail('remote PID probed') });
      assert.equal(record.observation, 'unknown');
      assert.equal(record.live, null);
    }
  }
  assert.equal(observeInstances(fixture([{ ...instance, host: 'local-mac' }]), options)[0].live, true);
});

test('only ESRCH proves a process is dead; permission and probe failures stay unknown', () => {
  for (const code of ['ESRCH', 'EPERM', 'EACCES', 'EIO']) {
    assert.equal(processIsLive(42, () => { throw Object.assign(new Error(), { code }); }), code === 'ESRCH' ? false : null);
  }
  for (const pid of [null, undefined, 0, -1, '42', 1.5]) {
    assert.equal(processIsLive(pid, () => assert.fail('invalid PID probed')), null);
  }
  assert.equal(processIsLive(42, (pid, signal) => { assert.equal(pid, 42); assert.equal(signal, 0); }), true);
});
