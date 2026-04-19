import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startServer } from './server.js';

async function canBindLocalhost(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, '127.0.0.1', () => {
      probe.close(() => resolve(true));
    });
  });
}

async function startTestServer(_t: TestContext) {
  return await startServer({ port: 0, host: '127.0.0.1', authToken: 'test-token' });
}

test('execution worker reports localhost-only health by default', async (t) => {
  if (!(await canBindLocalhost())) {
    t.skip('socket binding is not permitted in this environment');
    return;
  }
  const srv = await startTestServer(t);
  try {
    const res = await fetch(`http://${srv.host}:${srv.port}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mode, 'execution-worker');
    assert.equal(body.host, '127.0.0.1');
  } finally {
    await srv.close();
  }
});

test('execution worker serves the root UI and bootstraps auth cookie', async (t) => {
  if (!(await canBindLocalhost())) {
    t.skip('socket binding is not permitted in this environment');
    return;
  }
  const srv = await startTestServer(t);
  try {
    const res = await fetch(`http://${srv.host}:${srv.port}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie') || '', /hii_auth=test-token/);
    const body = await res.text();
    assert.match(body, /hii Vault Viewer/i);
  } finally {
    await srv.close();
  }
});

test('execution worker denies unauthenticated chat requests', async (t) => {
  if (!(await canBindLocalhost())) {
    t.skip('socket binding is not permitted in this environment');
    return;
  }
  const srv = await startTestServer(t);
  try {
    const res = await fetch(`http://${srv.host}:${srv.port}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    });
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test('dangerous browser surface is disabled by default even with auth', async (t) => {
  if (!(await canBindLocalhost())) {
    t.skip('socket binding is not permitted in this environment');
    return;
  }
  const srv = await startTestServer(t);
  try {
    const res = await fetch(`http://${srv.host}:${srv.port}/browser`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-token',
      },
      body: JSON.stringify({ args: [] }),
    });
    assert.equal(res.status, 403);
  } finally {
    await srv.close();
  }
});

test('ingest refuses paths outside the HII roots', async (t) => {
  if (!(await canBindLocalhost())) {
    t.skip('socket binding is not permitted in this environment');
    return;
  }
  const srv = await startTestServer(t);
  try {
    const res = await fetch(`http://${srv.host}:${srv.port}/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-token',
      },
      body: JSON.stringify({ path: '/etc/passwd' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(String(body.error || ''), /allowed HII roots/i);
  } finally {
    await srv.close();
  }
});
