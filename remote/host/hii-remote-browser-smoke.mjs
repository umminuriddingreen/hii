#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-BSL-1.1
// Local-only regression for the paired host's persistent, isolated profile.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'hii-browser-profile-smoke-'));
process.env.HII_REMOTE_BROWSER_PROFILE_ROOT = root;
const { BrowserSession } = await import('./hii-remote-browser.mjs');
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<!doctype html><title>HII Browser Smoke</title><button>Open</button>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
let first;
let second;
let contender;
try {
  let frames = 0;
  first = new BrowserSession('grant-a', (message) => { if (message.t === 'browser.frame') frames++; }, 'paired-host-test');
  await first.open(url);
  await first.input({ event: 'mousePressed', x: 80, y: 80 });
  await first.input({ event: 'mouseReleased', x: 80, y: 80 });
  const stored = await first.command('Network.setCookie', {
    name: 'hii_profile_smoke', value: 'survived', url, expires: Math.floor(Date.now() / 1000) + 3600,
  });
  assert.equal(stored.success, true);
  await new Promise((resolve) => setTimeout(resolve, 500));
  contender = new BrowserSession('grant-b', () => {}, 'paired-host-test');
  await assert.rejects(contender.open(url), /browser_profile_in_use/);
  await contender.close();
  await first.close();
  first = null;
  second = new BrowserSession('grant-c', () => {}, 'paired-host-test');
  await second.open(url);
  const cookies = await second.command('Network.getCookies', { urls: [url] });
  assert.ok(cookies.cookies.some((cookie) => cookie.name === 'hii_profile_smoke' && cookie.value === 'survived'));
  assert.ok(frames > 0, 'the first session streamed a page frame');
  console.log('persistent profile, exclusive lock, page frame, and browser input: passed');
} finally {
  await Promise.allSettled([first?.close(), second?.close(), contender?.close()]);
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
