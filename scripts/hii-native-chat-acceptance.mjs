// SPDX-License-Identifier: LicenseRef-BSL-1.1
// Runs the packaged-protocol Windows HII app against an existing local GGUF.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');
const executable = process.env.HII_DESKTOP_EXE || path.join(root, 'src-tauri/target/debug/hii.exe');
const cli = process.env.HII_CLI_BIN || path.join(root, 'target/debug/hii.exe');
const llama = process.env.LLAMA_SERVER_EXE;
const gguf = process.env.LLAMA_MODEL_PATH;
assert.equal(process.platform, 'win32', 'This acceptance test requires Windows');
for (const [label, file] of Object.entries({ HII_DESKTOP_EXE: executable, HII_CLI_BIN: cli, LLAMA_SERVER_EXE: llama, LLAMA_MODEL_PATH: gguf })) {
  assert(file && path.isAbsolute(file) && existsSync(file), `${label} must name an existing absolute path`);
}
const playwright = process.env.HII_PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(path.resolve(process.env.HII_PLAYWRIGHT_MODULE)).href)
  : await import('playwright');
const { chromium } = playwright;
const port = Number(process.env.HII_CHAT_TEST_PORT || 18080);
const debugPort = Number(process.env.HII_CHAT_DEBUG_PORT || 9223);
for (const value of [port, debugPort]) assert(Number.isInteger(value) && value > 1024 && value < 65536);
assert.notEqual(port, debugPort);
const started = Date.now();
const run = path.join(root, 'artifacts', `native-chat-acceptance-${started}`);
const runtime = path.join(run, 'runtime');
const database = path.join(runtime, 'hii.db');
await mkdir(runtime, { recursive: true });
const appEnv = { ...process.env,
  HII_ROOT: root,
  HII_RUNTIME_DIR: runtime,
  HII_DB_PATH: database,
  HII_UI_DIR: path.join(run, 'ui'),
  HII_UI_URL: '',
  HII_ACCOUNT_DIR: path.join(runtime, 'account'),
  HII_ACCOUNT_API: 'http://127.0.0.1:1/api/device',
  HII_CLI_BIN: cli,
  WEBVIEW2_USER_DATA_FOLDER: path.join(run, 'webview'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
};
const report = { executable, cli, runtime, database, llama, model: gguf, checks: [], screenshots: [], errors: [], blockedNetworkOrigins: [], timings: [] };
const logs = [];
let child;
let browser;
let page;
let launchError;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function progress(message) {
  const elapsedSeconds = Math.round((Date.now() - started) / 1000);
  report.timings.push({ elapsedSeconds, message });
  console.log(`[${elapsedSeconds}s] ${message}`);
}
function query(sql, ...bindings) {
  const db = new DatabaseSync(database, { readOnly: true });
  try { db.exec('PRAGMA busy_timeout=5000'); return db.prepare(sql).all(...bindings); }
  finally { db.close(); }
}
async function until(fn, label, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  let last;
  let nextProgress = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`HII exited during ${label}`);
    try { const result = await fn(); if (result) return result; }
    catch (error) { if (error instanceof assert.AssertionError) throw error; last = error; }
    if (Date.now() >= nextProgress) { progress(`Waiting: ${label}`); nextProgress += 15_000; }
    await delay(150);
  }
  throw new Error(`Timed out: ${label}. ${last || ''}`);
}
async function requireFreePort(value) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(value, '127.0.0.1', () => server.close(resolve));
  });
}
async function launch() {
  progress('Launching native HII');
  launchError = null;
  child = spawn(executable, [], { cwd: root, windowsHide: true, env: appEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => logs.push(chunk.toString()));
  child.stderr.on('data', chunk => logs.push(chunk.toString()));
  child.once('error', error => { launchError = error; });
  await until(async () => (await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1000) })).ok, 'WebView2 debugger', 40_000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  for (const context of browser.contexts()) {
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (!['http:', 'https:'].includes(url.protocol) || ['tauri.localhost', 'ipc.localhost', 'localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return route.continue();
      report.blockedNetworkOrigins.push(url.origin);
      return route.abort('blockedbyclient');
    });
  }
  page = await until(() => browser.contexts().flatMap(context => context.pages()).find(candidate => /tauri|localhost/.test(candidate.url())), 'HII webview', 30_000);
  page.on('pageerror', error => report.errors.push(String(error)));
  page.setDefaultTimeout(10_000);
  const chat = page.getByRole('button', { name: 'Chat', exact: true });
  await chat.waitFor();
  assert.equal(await page.getByRole('button', { name: 'Canvas', exact: true }).getAttribute('aria-pressed'), 'true');
  const linked = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('account_sync_status'));
  assert.equal(linked.linked, false, 'Acceptance account directory must be isolated from the live account');
  await chat.click();
  await until(() => page.getByRole('button', { name: 'New conversation', exact: true }).isEnabled(), 'HII Chat ready', 30_000);
}
async function closeApp(crash = false) {
  progress(crash ? 'Forcing HII process crash' : 'Closing HII normally');
  const exiting = new Promise(resolve => child.once('exit', resolve));
  if (crash) child.kill();
  else execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).CloseMainWindow() | Out-Null`], { windowsHide: true });
  await Promise.race([exiting, delay(10_000).then(() => { assert(child.exitCode !== null || child.signalCode !== null, 'HII did not close'); })]);
  await browser.close().catch(() => {});
  browser = null;
  child = null;
  await delay(1200);
}
async function screenshot(name) {
  const file = path.join(run, `${name}.png`);
  await page.bringToFront();
  const session = await page.context().newCDPSession(page);
  try {
    const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(file, Buffer.from(data, 'base64'));
  } finally { await session.detach(); }
  report.screenshots.push(file);
}
function message(generation) { return page.locator(`article[data-message-id="${generation.message_id}"]`); }
function parts(generation) { return query('SELECT position,kind,content FROM chat_message_parts WHERE message_id=? ORDER BY position', generation.message_id); }
async function visibleParts(generation) {
  return message(generation).locator('.message-body').evaluate(element => [...element.children]
    .filter(child => !child.classList.contains('stream-cursor'))
    .map(child => child.tagName === 'DETAILS' ? { kind: 'reasoning', content: child.querySelector('div')?.textContent || '' } : { kind: 'text', content: child.textContent || '' }));
}
async function send(prompt) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(prompt);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  return until(() => query("SELECT g.id,g.conversation_id,g.message_id FROM chat_generations g JOIN chat_messages assistant ON assistant.id=g.message_id JOIN chat_message_parts prompt ON prompt.message_id=assistant.parent_id WHERE prompt.content=? ORDER BY g.started_at DESC", prompt)[0], 'generation identity', 15_000);
}
async function startRuntime(configure = false) {
  await page.getByRole('button', { name: /Local runtime/i }).click();
  if (configure) {
    await page.locator('input[name=endpoint]').fill(`http://127.0.0.1:${port}/v1`);
    await page.locator('input[name=model]').fill('hii-local-acceptance');
    await page.locator('input[name=max_tokens]').fill('1024');
    await page.locator('input[name=context_size]').fill('4096');
    await page.locator('input[name=managed]').check();
    await page.locator('input[name=executable]').fill(llama);
    await page.locator('input[name=model_path]').fill(gguf);
  }
  await page.getByRole('button', { name: 'Start runtime', exact: true }).click();
  await until(async () => {
    const errors = await page.getByRole('dialog').locator('[role=alert]').allTextContents();
    assert.equal(errors.length, 0, errors.join('; '));
    return (await page.locator('.runtime-state').textContent()) === 'ready';
  }, 'Rust-managed llama.cpp ready');
  await page.getByRole('button', { name: 'Close runtime settings' }).click();
}

try {
  await requireFreePort(port);
  await requireFreePort(debugPort);
  progress('Initializing isolated HII information store through CLI');
  execFileSync(cli, ['info', 'find', 'acceptance-baseline', '--json'], { cwd: root, env: appEnv, windowsHide: true, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  let graphSchema = query("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'chat_%' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  assert(graphSchema.some(row => row.name === 'information_sources'), 'CLI must initialize HII information tables in the shared HII_DB_PATH');
  const originalVersion = query('PRAGMA user_version')[0].user_version;
  await launch();
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('runtime_space_snapshot_v1', { spaceId: 'acceptance' }));
  graphSchema = query("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'chat_%' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  for (const table of ['information_sources', 'operational_objects', 'operational_relations', 'runtime_spaces']) assert(graphSchema.some(row => row.name === table), `Shared HII graph table missing: ${table}`);
  report.graphTables = graphSchema.map(row => row.name);
  report.checks.push('Native HII launched with Canvas default and isolated unlinked account');
  await startRuntime(true);
  report.checks.push('Rust launched existing llama.cpp and discovered a local model');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  const first = await send(`Write eight short numbered sentences explaining why local conversation persistence matters. Begin directly with sentence 1. /no_think [test ${started}]`);
  report.conversationId = first.conversation_id;
  report.generationId = first.id;
  const partials = new Set();
  await until(async () => {
    const status = await message(first).getAttribute('data-status');
    assert.notEqual(status, 'failed', await message(first).innerText());
    const output = await visibleParts(first);
    if (status === 'streaming' && output.some(part => part.content.length)) partials.add(JSON.stringify(output));
    return status === 'completed';
  }, 'real local inference completion', 240_000);
  assert(partials.size >= 2, `Expected multiple streamed partial responses, got ${partials.size}`);
  const completed = await visibleParts(first);
  assert(completed.some(part => part.content.length > 30), 'Expected substantial text or reasoning output');
  assert.deepEqual(parts(first).map(({ kind, content }) => ({ kind, content })), completed);
  assert.equal(query('SELECT status FROM chat_generations WHERE id=?', first.id)[0].status, 'completed');
  report.visiblePartialUpdates = partials.size;
  report.checks.push('Provider -> Rust -> Tauri -> React streamed committed parts matching SQLite');
  await screenshot('chat-completed');
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  assert.equal(await message(first).isVisible(), false);
  await screenshot('canvas-preserved');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  assert.deepEqual(await visibleParts(first), completed);
  report.checks.push('Canvas -> Chat surface switches preserved the same conversation and response');
  await closeApp();
  await launch();
  await until(async () => await message(first).isVisible(), 'conversation restored', 30_000);
  assert.deepEqual(await visibleParts(first), completed);
  assert.equal(query('SELECT conversation_id FROM chat_generations WHERE id=?', first.id)[0].conversation_id, first.conversation_id);
  report.checks.push('Normal app restart restored identical conversation, generation and response parts');
  await screenshot('chat-restored');
  await startRuntime();
  const crashing = await send(`Write 100 numbered sentences about reliable local software. /no_think [crash ${started}]`);
  report.crashGenerationId = crashing.id;
  await until(async () => {
    const status = await message(crashing).getAttribute('data-status');
    assert.equal(status, 'streaming', 'Crash probe must still be generating');
    const reasoning = message(crashing).locator('details');
    for (const detail of await reasoning.all()) if ((await detail.getAttribute('open')) === null) await detail.locator('summary').click();
    return (await visibleParts(crashing)).some(part => part.content.length > 35);
  }, 'visible text or reasoning before crash');
  const beforeCrash = parts(crashing);
  assert(beforeCrash.length > 0);
  await screenshot('before-crash');
  await closeApp(true);
  await until(async () => await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }).then(() => false, () => true), 'owned runtime exit', 15_000);
  await launch();
  await until(async () => await message(crashing).getAttribute('data-status') === 'interrupted', 'interrupted generation recovered', 30_000);
  const recovered = parts(crashing);
  for (const part of beforeCrash) assert(recovered.find(candidate => candidate.position === part.position && candidate.kind === part.kind)?.content.startsWith(part.content), 'Every committed partial must survive the crash');
  assert.equal(query('SELECT status FROM chat_generations WHERE id=?', crashing.id)[0].status, 'interrupted');
  assert.deepEqual(query("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'chat_%' AND name NOT LIKE 'sqlite_%' ORDER BY name").filter(row => graphSchema.some(original => original.name === row.name)), graphSchema);
  assert.equal(query('PRAGMA user_version')[0].user_version, originalVersion);
  assert.equal(query('PRAGMA integrity_check')[0].integrity_check, 'ok');
  report.checks.push('Forced crash recovered committed text/reasoning and interrupted generation by exact ID');
  report.checks.push('Windows Job Object terminated app-owned llama.cpp after crash');
  report.checks.push('Shared SQLite graph schemas and user_version survived chat; integrity_check passed');
  await screenshot('crash-recovered');
  assert.equal(report.errors.length, 0, 'No WebView JavaScript errors');
  assert.equal(report.blockedNetworkOrigins.length, 0, 'No cloud requests should be attempted by the acceptance flow');
  report.passed = true;
  await closeApp();
  progress('Acceptance passed');
} catch (error) {
  report.passed = false;
  report.failure = String(error.stack || error);
  if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
  process.exitCode = 1;
  progress('Acceptance failed; see report.json');
} finally {
  if (child?.exitCode === null && child.signalCode === null) child.kill();
  await browser?.close().catch(() => {});
  await writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(run, 'app.log'), logs.join(''));
  console.log(`Report: ${path.join(run, 'report.json')}`);
}
