import os from 'node:os';

// hiid publishes every few seconds. Old PIDs can be reused, so probing a PID
// from an expired snapshot cannot establish the identity of a running process.
export const INSTANCE_MAX_AGE_MS = 120_000;

export function processIsLive(pid, probe = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    probe(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'ESRCH' ? false : null;
  }
}

export function observeInstances(document, {
  now = Date.now(), hostname = os.hostname(), probe = processIsLive,
} = {}) {
  const updatedAt = Date.parse(document?.updatedAt);
  const fresh = Number.isFinite(updatedAt) && updatedAt <= now && now - updatedAt <= INSTANCE_MAX_AGE_MS;
  const records = Array.isArray(document?.instances) ? document.instances : [];
  return records.filter((record) => record &&
    ['queued', 'running', 'working', 'attention'].includes(String(record.status).toLowerCase())
  ).map((record) => {
    // Legacy hiid snapshots are local-only. Explicit device/host metadata must
    // never allow a remote PID to be tested against this machine's PID table.
    const hosts = [record.host, record.hostname, document?.host, document?.hostname].filter((host) => host != null);
    const local = record.remote !== true && document?.remote !== true &&
      [record.machine, record.machineId, record.deviceId, document?.machine, document?.machineId, document?.deviceId].every((id) => id == null) &&
      hosts.every((host) => host === hostname || host === 'localhost' || host === '127.0.0.1' || host === '::1');
    const live = fresh && local ? probe(record.pid) : null;
    return { ...record, live, observation: !fresh ? 'stale' : live === true ? 'live' : live === false ? 'dead' : 'unknown' };
  });
}
