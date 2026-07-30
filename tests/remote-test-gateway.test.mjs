import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ARTIFACT_HTTPS_PORT,
  MODEL,
  TERMINAL_HTTPS_PORT,
  archiveSessionForReset,
  ensureSessionLayout,
  funnelStartArgs,
  funnelStopArgs,
  inspectPreflight,
  resolvePublicArtifact,
  routeOwnedBy
} from '../server/remote-test-core.mjs';
import { chromeFailure, verifyArtifact } from '../server/remote-test-artifacts.mjs';
import { createSandbox, sanitizedHostEnv } from '../server/remote-test-sandbox.mjs';
import { replayTranscript, startRemoteTestGateway } from '../server/remote-test-gateway.mjs';
import { createImprovementRecorder } from '../server/remote-test-learning.mjs';
import { analyzeRemoteTests, formatHarnessInsights } from '../server/remote-test-insights.mjs';
import { runRemoteEvaluation } from '../server/remote-test-eval.mjs';
import { startModelBridge } from '../server/remote-test-model-bridge.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function temporary() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'hii-remote-test-'));
}

async function childResult(binary, args, options) {
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, options);
    const stdout = [];
    const stderr = [];
    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8')
    }));
  });
}

test('artifact boundary rejects traversal, dotfiles, and symlinks', async (context) => {
  const root = await temporary();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const layout = await ensureSessionLayout(root, '20260730120000-1234567890abcdef12345678');
  await fs.writeFile(path.join(layout.publicDir, 'ok.txt'), 'ok');
  await fs.writeFile(path.join(layout.publicDir, '.secret'), 'no');
  await fs.symlink(path.join(layout.publicDir, 'ok.txt'), path.join(layout.publicDir, 'link.txt'));
  assert.equal(await resolvePublicArtifact(layout.publicDir, 'ok.txt'), await fs.realpath(path.join(layout.publicDir, 'ok.txt')));
  await assert.rejects(() => resolvePublicArtifact(layout.publicDir, '../runtime/secret'));
  await assert.rejects(() => resolvePublicArtifact(layout.publicDir, '%2e%2e/runtime/secret'));
  await assert.rejects(() => resolvePublicArtifact(layout.publicDir, '.secret'));
  await assert.rejects(() => resolvePublicArtifact(layout.publicDir, 'link.txt'));
});

test('session reset archives active state without deleting saved evidence or changing identity', async (context) => {
  const root = await temporary();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const layout = await ensureSessionLayout(root, '20260730123456-aaaaaaaaaaaaaaaaaaaaaaaa');
  await fs.writeFile(path.join(layout.publicDir, 'index.html'), '<h1>Old preview</h1>');
  await fs.writeFile(layout.transcript, 'old transcript');
  await fs.mkdir(path.join(layout.sessionDir, 'home'), { recursive: true });
  await fs.mkdir(path.join(layout.sessionDir, 'tmp'), { recursive: true });
  await fs.writeFile(layout.manifest, JSON.stringify({ id: layout.id, savedArtifacts: [{ id: 'saved-1' }] }));

  const archived = await archiveSessionForReset(layout.sessionDir);

  assert.deepEqual(
    archived.moved.sort(),
    ['home', 'runtime', 'tmp', 'transcript.log', 'workspace'].sort()
  );
  assert.equal(await fs.readFile(path.join(archived.historyRoot, 'transcript.log'), 'utf8'), 'old transcript');
  assert.equal(
    await fs.readFile(path.join(archived.historyRoot, 'workspace', 'public', 'index.html'), 'utf8'),
    '<h1>Old preview</h1>'
  );
  assert.deepEqual(JSON.parse(await fs.readFile(layout.manifest, 'utf8')).savedArtifacts, [{ id: 'saved-1' }]);
  await assert.rejects(fs.access(layout.workspace));
  await assert.rejects(fs.access(layout.transcript));
});

test('harness insights report measured traces and name unmeasured evidence honestly', async (context) => {
  const root = await temporary();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await ensureSessionLayout(root, '20260730123456-bbbbbbbbbbbbbbbbbbbbbbbb');
  await ensureSessionLayout(root, '20260730123457-cccccccccccccccccccccccc');
  await fs.writeFile(first.manifest, JSON.stringify({ model: MODEL, outcome: 'running' }));
  await fs.writeFile(
    first.events,
    [
      { at: '2026-07-30T12:00:00.000Z', type: 'terminal-input', bytes: 5 },
      { at: '2026-07-30T12:00:10.000Z', type: 'artifact-verified', path: 'index.html', ok: false },
      { at: '2026-07-30T12:00:20.000Z', type: 'artifact-verified', path: 'index.html', ok: true }
    ].map((event) => JSON.stringify(event)).join('\n')
  );
  await fs.writeFile(
    first.transcript,
    'test -s public/index.html\nREPEATED_ACTION\nMODEL LOOP DETECTED\nResponse interrupted\n'
  );
  const conversations = path.join(first.runtime, 'conversations', 'cli');
  await fs.mkdir(conversations, { recursive: true });
  const repeatedPhrase = 'measure the same eight word phrase again right now';
  await fs.writeFile(
    path.join(conversations, 'conversation-1.jsonl'),
    [
      {
        conversation_id: 'conversation-1',
        kind: 'user.message',
        ts_unix_ms: 1_000,
        data: { content: 'build it' }
      },
      {
        conversation_id: 'conversation-1',
        kind: 'usage.model_call',
        ts_unix_ms: 1_900,
        data: { prompt_tokens: 120 }
      },
      {
        conversation_id: 'conversation-1',
        kind: 'model.thinking',
        ts_unix_ms: 1_950,
        data: { content: `${repeatedPhrase}. ${repeatedPhrase}.` }
      },
      {
        conversation_id: 'conversation-1',
        kind: 'model.action',
        ts_unix_ms: 2_000,
        data: { content: '{"type":"write"}' }
      },
      {
        conversation_id: 'conversation-1',
        kind: 'assistant.message',
        ts_unix_ms: 3_000,
        data: { content: 'Done' }
      }
    ].map((event) => JSON.stringify(event)).join('\n')
  );

  const report = await analyzeRemoteTests(root);
  const formatted = formatHarnessInsights(report);

  assert.equal(report.metrics.sessions, 2);
  assert.equal(report.metrics.conversationTasks, 1);
  assert.equal(report.metrics.completedConversations, 1);
  assert.equal(report.metrics.conversationCompletionRate, 1);
  assert.equal(report.metrics.sessionsWithWork, 1);
  assert.equal(report.metrics.completedArtifactSessions, 1);
  assert.equal(report.metrics.artifactSessionCompletionRate, 1);
  assert.equal(report.metrics.verificationChecks, 2);
  assert.equal(report.metrics.browserVerificationSuccessRate, 0.5);
  assert.equal(report.metrics.failedBrowserChecks, 1);
  assert.equal(report.metrics.uniqueArtifacts, 1);
  assert.equal(report.metrics.repairedArtifacts, 1);
  assert.equal(report.metrics.testerInputBursts, 1);
  assert.equal(report.metrics.repeatedActions, 1);
  assert.equal(report.metrics.modelLoops, 1);
  assert.equal(report.metrics.interruptions, 1);
  assert.equal(report.metrics.weakHtmlFileChecks, 1);
  assert.equal(report.metrics.medianTimeToFirstVerifiedArtifactMs, 20_000);
  assert.equal(report.metrics.medianTimeToFirstActionMs, 1_000);
  assert.equal(report.metrics.medianPromptTokensBeforeFirstAction, 120);
  assert.ok(report.metrics.repetitiveThinkingNgramRate > 0);
  assert.equal(report.metrics.followUpUserMessages, 0);
  assert.equal(report.installsChangesAutomatically, false);
  assert.match(formatted, /HARNESS INSIGHT/);
  assert.match(formatted, /No harness source change is installed automatically/);
  assert.match(report.coverageGaps.join(' '), /Tester acceptance/);
  assert.doesNotMatch(report.coverageGaps.join(' '), /Tokens before first action/);
});

test('local evaluation refuses an empty goal before starting a gateway', async () => {
  await assert.rejects(
    runRemoteEvaluation({
      root: '/tmp/unused-hii-eval',
      hiiBinary: process.execPath,
      prompt: '   '
    }),
    /evaluation prompt is required/
  );
});

test('a failed browser check followed by proof becomes a reusable lesson, not an installed patch', async (context) => {
  const root = await temporary();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const layout = await ensureSessionLayout(root, '20260730120000-abcdefabcdefabcdefabcdef');
  const recorder = createImprovementRecorder({ root, layout });
  await recorder.refreshContext();
  await recorder.failed('site.html', { failures: ['js: import map missing at /Users/test/site.html'] });
  await recorder.passed('site.html', { httpStatus: 200 });
  const contextText = await fs.readFile(recorder.sessionLessons, 'utf8');
  assert.match(contextText, /Verified reusable lessons/);
  assert.match(contextText, /Chrome acceptance/);
  await assert.rejects(fs.stat(path.join(root, 'improvement-proposals')));
});

test('preflight refuses occupied Funnel routes and never mutates them', async () => {
  const calls = [];
  const status = {
    BackendState: 'Running',
    Self: { DNSName: 'mac.example.ts.net.' },
    Web: {
      'mac.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } }
    }
  };
  const run = async (_binary, args) => {
    calls.push(args);
    if (args[0] === 'status') return { code: 0, stdout: JSON.stringify(status), stderr: '' };
    return { code: 0, stdout: JSON.stringify(status), stderr: '' };
  };
  const report = await inspectPreflight({
    run,
    canBind: async () => true,
    fetchImpl: async () => ({ ok: true, json: async () => ({ models: [{ name: MODEL }] }) }),
    hiiBinary: process.execPath,
    requireChrome: false
  });
  assert.equal(report.ok, false);
  assert.equal(report.tailscaleDnsName, 'mac.example.ts.net.');
  assert.equal(report.checks.find((item) => item.name === 'funnel-443-unused').ok, false);
  assert.equal(calls.some((args) => args.includes('reset') || args.includes('off') || args.includes('--bg')), false);
});

test('Funnel commands use exact routes and exact teardown, never reset', () => {
  assert.deepEqual(funnelStartArgs(TERMINAL_HTTPS_PORT, 17171), [
    'funnel', '--bg', '--yes', '--https=443', 'http://127.0.0.1:17171'
  ]);
  assert.deepEqual(funnelStopArgs(ARTIFACT_HTTPS_PORT), ['funnel', '--https=8443', 'off']);
  const status = {
    Web: {
      'mac.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:17171' } } }
    }
  };
  assert.equal(routeOwnedBy(status, 443, 17171), true);
  assert.equal(routeOwnedBy(status, 443, 9999), false);
});

test('public-test sandbox retains host PATH but removes secrets and denies deletion', async (context) => {
  const root = await temporary();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const layout = await ensureSessionLayout(root, '20260730120000-abcdefabcdefabcdefabcdef');
  const hostEnv = {
    PATH: `/opt/homebrew/bin:${path.join(os.homedir(), '.local', 'bin')}:/usr/local/bin:/usr/bin:/bin`,
    LANG: 'en_US.UTF-8',
    NO_COLOR: '1',
    OPENAI_API_KEY: 'do-not-copy',
    RANDOM_TOKEN: 'do-not-copy',
    AWS_PROFILE: 'private-profile',
    SSH_AUTH_SOCK: '/private/tmp/private-agent.sock',
    NODE_OPTIONS: '--require=/private/tmp/inject.js'
  };
  const env = sanitizedHostEnv({ layout, hostEnv });
  assert.equal(env.PATH.includes(os.homedir()), false);
  assert.equal(env.PATH.includes('/opt/homebrew/bin'), true);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.RANDOM_TOKEN, undefined);
  assert.equal(env.AWS_PROFILE, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NO_COLOR, undefined);
  assert.equal(env.COLORTERM, 'truecolor');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.HOME.startsWith(layout.sessionDir), true);
  assert.equal(env.HII_RUNTIME_DIR, layout.runtime);
  const sandbox = await createSandbox({ layout, hiiBinary: '/bin/sh', hostEnv });
  const profile = await fs.readFile(sandbox.profilePath, 'utf8');
  assert.match(profile, /\(allow network-outbound \(remote ip "localhost:\*"\)\)/);
  assert.doesNotMatch(profile, /\(allow network\*\)/);
  assert.match(profile, /\(allow pseudo-tty\)/);
  assert.match(profile, /\(allow file-ioctl\)/);
  assert.match(profile, /\(deny file-write-unlink/);
  const escapedHome = os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(profile, new RegExp(`\\(deny file-read\\* \\(subpath "${escapedHome}"\\)\\)`));
  assert.match(profile, /\(deny file-read\* \(subpath "\/Volumes"\)\)/);
  assert.doesNotMatch(profile, new RegExp(`\\(allow file-read\\* \\(subpath "${escapedHome}"\\)\\)`));
  assert.deepEqual(sandbox.args.slice(-1), ['/bin/sh']);
  if (process.platform === 'darwin') {
    const target = path.join(layout.workspace, 'sandbox-write.txt');
    const probe = spawnSync(sandbox.launcher, [
      ...sandbox.args,
      '-c',
      `if IFS= read -r line < "$2/.zshrc"; then host_read=true; else host_read=false; fi
printf ok > "$1"
if /bin/rm "$1" 2>/dev/null; then delete_denied=false; else delete_denied=true; fi
printf '{"hostRead":%s,"deleteDenied":%s,"wrote":"%s"}' "$host_read" "$delete_denied" "$(/bin/cat "$1")"`,
      'hii-sandbox-probe',
      target,
      os.homedir()
    ], { encoding: 'utf8', env });
    assert.equal(probe.status, 0, JSON.stringify({ error: probe.error?.message, signal: probe.signal, stderr: probe.stderr }));
    assert.deepEqual(JSON.parse(probe.stdout), { hostRead: false, deleteDenied: true, wrote: 'ok' }, profile);

    const loopback = net.createServer((socket) => socket.end('ok'));
    await new Promise((resolve, reject) => {
      loopback.once('error', reject);
      loopback.listen(0, '127.0.0.1', resolve);
    });
    const port = loopback.address().port;
    const localNetwork = await childResult(sandbox.launcher, [
      ...sandbox.args,
      '-c',
      `/opt/homebrew/bin/python3 -c 'import socket; print(socket.create_connection(("127.0.0.1", ${port}), 2).recv(2).decode())'`
    ], { cwd: layout.workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve) => loopback.close(resolve));
    assert.equal(localNetwork.code, 0, localNetwork.stderr);
    assert.equal(localNetwork.stdout.trim(), 'ok');

    const externalNetwork = await childResult(sandbox.launcher, [
      ...sandbox.args,
      '-c',
      "/opt/homebrew/bin/python3 -c 'import socket; socket.create_connection((\"1.1.1.1\", 80), 1)'"
    ], { cwd: layout.workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.notEqual(externalNetwork.code, 0, 'public-test sandbox unexpectedly reached the public network');
  }
});

test('local model bridge owns external web search for the loopback-only HII process', async (context) => {
  const server = await startModelBridge({
    port: 0,
    workspace: repository,
    fetchImpl: async (url, options) => {
      assert.match(String(url), /duckduckgo\.com\/html\/\?q=three\.js/);
      assert.equal(options.signal instanceof AbortSignal, true);
      return {
        ok: true,
        status: 200,
        text: async () => '<html><body>local proxy result</body></html>'
      };
    }
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/hii/web-search?q=three.js`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<html><body>local proxy result</body></html>');
});

test('Chrome diagnostics retain actionable exception, console, and asset details', () => {
  assert.match(chromeFailure({
    method: 'Runtime.exceptionThrown',
    params: {
      exceptionDetails: {
        text: 'Uncaught',
        url: 'http://127.0.0.1:1234/index.html',
        lineNumber: 8,
        columnNumber: 4,
        exception: { description: 'ReferenceError: missingThing is not defined\n    at index.html:9:5' }
      }
    }
  }), /ReferenceError: missingThing is not defined.*index\.html:9:5/);
  assert.equal(chromeFailure({
    method: 'Runtime.consoleAPICalled',
    params: { type: 'error', args: [{ value: 'shader failed' }, { value: 17 }] }
  }), 'console: shader failed 17');
  assert.equal(chromeFailure({
    method: 'Network.responseReceived',
    params: { response: { status: 404, url: 'http://127.0.0.1:1234/missing.js' } }
  }), 'asset: HTTP 404 http://127.0.0.1:1234/missing.js');
});

test('a reconnect receives the preserved terminal transcript', async (context) => {
  const root = await temporary();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const layout = await ensureSessionLayout(root, '20260730120000-040404040404040404040404');
  await fs.writeFile(layout.transcript, '\u001b[32mHII ready\u001b[0m\r\n◈ ');
  const messages = [];
  replayTranscript(layout, { send: (message) => messages.push(JSON.parse(message)) });
  assert.deepEqual(messages, [{
    type: 'data',
    data: '\u001b[32mHII ready\u001b[0m\r\n◈ '
  }]);
});

test('HTML publication requires Chrome instead of accepting a static false positive', async (context) => {
  const root = await temporary();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const layout = await ensureSessionLayout(root, '20260730120000-020202020202020202020202');
  await fs.writeFile(path.join(layout.publicDir, 'index.html'), '<!doctype html><html><body><main>Looks present</main></body></html>');
  const result = await verifyArtifact({
    publicDir: layout.publicDir,
    relativePath: 'index.html',
    artifactsDir: layout.artifacts,
    chromePath: false
  });
  assert.equal(result.ok, false);
  assert.equal(result.engine, 'chrome-required');
});

test('Three.js addon imports without an import map are rejected', async (context) => {
  const root = await temporary();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const layout = await ensureSessionLayout(root, '20260730120000-030303030303030303030303');
  await fs.writeFile(
    path.join(layout.publicDir, 'index.html'),
    `<!doctype html><html><body><main>Broken Three.js page</main><script type="module">
      import { FontLoader } from 'three/addons/loaders/FontLoader.js';
      document.body.dataset.loaded = String(Boolean(FontLoader));
    </script></body></html>`
  );
  const result = await verifyArtifact({
    publicDir: layout.publicDir,
    relativePath: 'index.html',
    artifactsDir: layout.artifacts
  });
  assert.equal(result.engine, 'chrome-cdp');
  assert.equal(result.ok, false);
  assert.ok(result.failures.length > 0);
});

test('browser verifier reports the actual JavaScript exception instead of generic Uncaught', async (context) => {
  const root = await temporary();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const layout = await ensureSessionLayout(root, '20260730120000-050505050505050505050505');
  await fs.writeFile(
    path.join(layout.publicDir, 'index.html'),
    '<!doctype html><html><body><main>Broken</main><script>missingThing()</script></body></html>'
  );
  const result = await verifyArtifact({
    publicDir: layout.publicDir,
    relativePath: 'index.html',
    artifactsDir: layout.artifacts
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => failure.includes('ReferenceError: missingThing is not defined')));
});

test('Three.js import-map fixture renders a canvas and captures a screenshot in Chrome', async (context) => {
  const root = await temporary();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const layout = await ensureSessionLayout(root, '20260730120000-aabbccddeeff001122334455');
  const fixture = path.join(repository, 'tests', 'fixtures', 'remote-test-three', 'public');
  await fs.cp(fixture, layout.publicDir, { recursive: true });
  const vendor = path.join(layout.publicDir, 'vendor');
  await fs.mkdir(vendor, { recursive: true });
  await Promise.all([
    fs.copyFile(path.join(repository, 'public', 'vendor', 'three.module.js'), path.join(vendor, 'three.module.js')),
    fs.copyFile(path.join(repository, 'public', 'vendor', 'three.core.js'), path.join(vendor, 'three.core.js'))
  ]);
  const result = await verifyArtifact({
    publicDir: layout.publicDir,
    relativePath: 'index.html',
    artifactsDir: layout.artifacts
  });
  assert.equal(result.engine, 'chrome-cdp');
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
  assert.equal(result.dom.canvases.length, 1);
  assert.equal(result.dom.backgroundColor, 'rgb(16, 19, 26)');
  assert.ok((await fs.stat(result.screenshot)).size > 1000);
});

test('public screen stays one work stream and one result with minimal preview controls', async () => {
  const html = await fs.readFile(path.join(repository, 'server', 'remote-test-static', 'index.html'), 'utf8');
  const css = await fs.readFile(path.join(repository, 'server', 'remote-test-static', 'style.css'), 'utf8');
  const app = await fs.readFile(path.join(repository, 'server', 'remote-test-static', 'app.js'), 'utf8');
  const main = html.match(/<main id="session" hidden>([\s\S]*?)<\/main>/)?.[1] ?? '';
  assert.match(main, /id="terminal"/);
  assert.match(main, /id="artifact"/);
  assert.doesNotMatch(main, /<(?:header|aside|footer)\b/);
  assert.equal((main.match(/<section\b/g) ?? []).length, 2);
  assert.equal((main.match(/<button\b/g) ?? []).length, 5);
  assert.match(main, /data-action="save"/);
  assert.doesNotMatch(html, /passcode|claim/i);
  assert.match(css, /#terminal \.xterm-rows/);
  assert.match(css, /--terminal-text:\s*var\(--bone\)/);
  assert.match(css, /#session\[data-signal="model"\]/);
  assert.match(css, /#session\[data-signal="tool"\]/);
  assert.match(css, /#session\[data-signal="verify"\]/);
  assert.match(css, /#session\[data-signal="proof"\]/);
  assert.match(css, /#session\[data-signal="error"\]/);
  assert.match(css, /@media \(max-width: 480px\)/);
  assert.match(app, /artifact\.style\.background/);
  assert.match(app, /trackActivity\(message\.data\)/);
  assert.match(app, /const EMPTY_PREVIEW_DOCUMENT/);
  assert.match(app, /artifact\.srcdoc = EMPTY_PREVIEW_DOCUMENT/);
  assert.match(app, /artifact\.removeAttribute\('srcdoc'\)/);
  assert.match(css, /grid-template-columns:\s*1fr 1fr/);
  assert.match(css, /grid-template-rows:\s*1fr 1fr/);
  assert.match(css, /#preview\s*\{\s*grid-row:\s*1/);
  assert.match(css, /#terminal\s*\{\s*grid-row:\s*2/);
  assert.match(css, /@media \(orientation: portrait\), \(max-aspect-ratio: 1\/1\)/);
});
