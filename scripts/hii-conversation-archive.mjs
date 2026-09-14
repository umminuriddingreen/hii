#!/usr/bin/env node
// Local, repeatable import of user/assistant conversation content into HII.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runtime = process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii');
const configPath = path.join(runtime, 'imports', 'conversation-sources.json');
const dbPath = process.env.HII_DB_PATH || path.join(runtime, 'hii.db');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const syncLabel = 'com.hii.conversation-archive-sync';
const syncPlist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${syncLabel}.plist`);
const syncLock = path.join(runtime, 'imports', 'sync.lock');
const lastSyncPath = path.join(runtime, 'imports', 'last-sync.json');

function configuration() {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch { return { schemaVersion: 1, codex: path.join(os.homedir(), '.codex', 'sessions'), chatgpt: [] }; }
}

function saveConfiguration(config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const temp = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, configPath);
}

function database() {
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS hii_imported_conversations (
      source_id TEXT PRIMARY KEY, provider TEXT NOT NULL, title TEXT NOT NULL,
      source_path TEXT NOT NULL, source_mtime_ms INTEGER NOT NULL, source_size INTEGER NOT NULL,
      content_hash TEXT NOT NULL, content TEXT NOT NULL, messages_json TEXT NOT NULL,
      imported_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hii_imported_provider ON hii_imported_conversations(provider);
    CREATE VIRTUAL TABLE IF NOT EXISTS hii_imported_conversations_fts USING fts5(source_id UNINDEXED, title, content);
    CREATE TRIGGER IF NOT EXISTS hii_imported_conversations_ai AFTER INSERT ON hii_imported_conversations BEGIN
      INSERT INTO hii_imported_conversations_fts(source_id,title,content) VALUES(new.source_id,new.title,new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS hii_imported_conversations_au AFTER UPDATE ON hii_imported_conversations BEGIN
      DELETE FROM hii_imported_conversations_fts WHERE source_id=old.source_id;
      INSERT INTO hii_imported_conversations_fts(source_id,title,content) VALUES(new.source_id,new.title,new.content);
    END;`);
  return db;
}

function textParts(content) {
  const parts = Array.isArray(content?.parts) ? content.parts : Array.isArray(content) ? content : [];
  return parts.map(part => typeof part === 'string' ? part :
    (part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text') ? part.text || '' : '')
    .filter(Boolean).join('\n').trim();
}

function record(db, { sourceId, provider, title, sourcePath, stat, messages }) {
  if (!messages.length) return 'empty';
  const content = messages.map(message => `${message.role}: ${message.text}`).join('\n\n');
  const digest = hash(JSON.stringify(messages));
  const current = db.prepare('SELECT content_hash FROM hii_imported_conversations WHERE source_id=?').get(sourceId);
  if (current?.content_hash === digest) return 'unchanged';
  db.prepare(`INSERT INTO hii_imported_conversations
    (source_id,provider,title,source_path,source_mtime_ms,source_size,content_hash,content,messages_json,imported_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source_id) DO UPDATE SET title=excluded.title,source_path=excluded.source_path,
    source_mtime_ms=excluded.source_mtime_ms,source_size=excluded.source_size,
    content_hash=excluded.content_hash,content=excluded.content,messages_json=excluded.messages_json,
    imported_at=excluded.imported_at`).run(sourceId, provider, title, sourcePath,
      Math.round(stat.mtimeMs), stat.size, digest, content, JSON.stringify(messages), new Date().toISOString());
  return current ? 'updated' : 'created';
}

function chatgptMessages(conversation) {
  return Object.values(conversation.mapping || {}).flatMap(node => {
    const message = node?.message;
    const role = message?.author?.role;
    if (!['user', 'assistant'].includes(role) || message?.metadata?.is_visually_hidden_from_conversation) return [];
    const text = textParts(message.content);
    return text ? [{ id: message.id || node.id, parent: node.parent || null, role, text,
      at: message.create_time || null }] : [];
  }).sort((a, b) => (a.at || 0) - (b.at || 0) || a.id.localeCompare(b.id));
}

function importChatgpt(db, file) {
  const stat = fs.statSync(file);
  const conversations = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(conversations)) throw new Error('ChatGPT export must be a conversations.json array');
  const counts = { created: 0, updated: 0, unchanged: 0, empty: 0 };
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const conversation of conversations) {
      const id = conversation.conversation_id || conversation.id;
      if (!id) continue;
      counts[record(db, { sourceId: `chatgpt:${id}`, provider: 'chatgpt',
        title: conversation.title || 'Untitled ChatGPT conversation', sourcePath: file, stat,
        messages: chatgptMessages(conversation) })]++;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { file, conversations: conversations.length, ...counts };
}

async function codexMessages(file) {
  const messages = [];
  let sessionId = path.basename(file, '.jsonl');
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; } // active session may end in an incomplete line
    if (event.type === 'session_meta') sessionId = event.payload?.id || event.payload?.session_id || sessionId;
    if (!event.type && event.id && !messages.length) sessionId = event.id; // older Codex JSONL header
    const item = event.type === 'response_item' ? event.payload : event.type === 'message' ? event : null;
    if (item?.type !== 'message') continue;
    const role = item.role;
    if (!['user', 'assistant'].includes(role) || (role === 'assistant' && !['final', 'commentary', undefined].includes(item.channel))) continue;
    const text = textParts(item.content);
    if (role === 'user' && text.startsWith('<environment_context>')) continue;
    if (text) messages.push({ id: `${event.ordinal ?? messages.length}`, role, text, at: event.timestamp || null });
  }
  return { sessionId, messages };
}

function* sessionFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sessionFiles(file);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield file;
  }
}

async function importCodex(db, root) {
  const counts = { created: 0, updated: 0, unchanged: 0, empty: 0, skipped: 0 };
  const cursor = db.prepare('SELECT source_mtime_ms,source_size FROM hii_imported_conversations WHERE source_id=?');
  for (const file of sessionFiles(root)) {
    const stat = fs.statSync(file);
    // One rollout file is one source. A continuation can carry the same
    // session_meta id as another file; keying on that id erased earlier text.
    const fileId = path.basename(file, '.jsonl').split('-').slice(-5).join('-');
    const sourceId = `codex:${fileId}`;
    const prior = cursor.get(sourceId);
    if (prior && prior.source_mtime_ms === Math.round(stat.mtimeMs) && prior.source_size === stat.size) {
      counts.skipped++; continue;
    }
    const { messages } = await codexMessages(file);
    counts[record(db, { sourceId, provider: 'codex',
      title: messages.find(message => message.role === 'user')?.text.slice(0, 120).replaceAll('\n', ' ') || path.basename(file),
      sourcePath: file, stat, messages })]++;
  }
  return { root, ...counts };
}

export async function sync(config = configuration()) {
  fs.mkdirSync(path.dirname(syncLock), { recursive: true, mode: 0o700 });
  if (fs.existsSync(syncLock)) {
    const pid = Number(fs.readFileSync(syncLock, 'utf8'));
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch {}
    if (alive) throw new Error(`archive sync already running as process ${pid}`);
    fs.unlinkSync(syncLock);
  }
  fs.writeFileSync(syncLock, String(process.pid), { flag: 'wx', mode: 0o600 });
  let db;
  try {
    db = database();
    const results = { schemaVersion: 1, kind: 'hii.archive.sync', chatgpt: [], codex: null };
    for (const file of config.chatgpt || []) results.chatgpt.push(importChatgpt(db, file));
    if (config.codex) results.codex = await importCodex(db, config.codex);
    fs.writeFileSync(lastSyncPath, `${JSON.stringify({ ...results, completedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    return results;
  } finally { db?.close(); fs.unlinkSync(syncLock); }
}

export async function archiveCommand(args) {
  const sub = args[0] || 'status';
  if (sub === 'install-sync') {
    if (process.platform !== 'darwin') throw new Error('automatic archive sync currently uses macOS launchd');
    if (fs.existsSync(syncPlist)) return { installed: true, path: syncPlist, note: 'existing schedule preserved' };
    const node = fs.existsSync('/opt/homebrew/bin/node') ? '/opt/homebrew/bin/node' : process.execPath;
    const cli = fileURLToPath(new URL('./hii-cli.mjs', import.meta.url));
    const xml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${syncLabel}</string>\n<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(cli)}</string><string>archive</string><string>sync</string></array>\n<key>StartInterval</key><integer>300</integer>\n<key>RunAtLoad</key><false/>\n<key>StandardOutPath</key><string>${xml(path.join(runtime, 'imports', 'sync.out.log'))}</string>\n<key>StandardErrorPath</key><string>${xml(path.join(runtime, 'imports', 'sync.err.log'))}</string>\n</dict></plist>\n`;
    fs.mkdirSync(path.dirname(syncPlist), { recursive: true });
    fs.mkdirSync(path.join(runtime, 'imports'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(syncPlist, plist, { mode: 0o600, flag: 'wx' });
    const result = spawnSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, syncPlist], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`schedule written but launchd registration failed: ${result.stderr.trim()}`);
    return { installed: true, path: syncPlist, intervalSeconds: 300 };
  }
  if (sub === 'connect') {
    const [, provider, rawPath] = args;
    if (!['chatgpt', 'codex'].includes(provider) || !rawPath) throw new Error('usage: hii archive connect chatgpt|codex <export-file-or-session-dir>');
    const source = fs.realpathSync(rawPath);
    const config = configuration();
    if (provider === 'chatgpt') {
      if (path.basename(source) !== 'conversations.json' || !fs.statSync(source).isFile()) throw new Error('ChatGPT source must be a conversations.json export');
      config.chatgpt = [...new Set([...(config.chatgpt || []), source])];
    } else {
      if (!fs.statSync(source).isDirectory()) throw new Error('Codex source must be a sessions directory');
      config.codex = source;
    }
    saveConfiguration(config);
    return { kind: 'hii.archive.sources', sources: config };
  }
  if (sub === 'sync') return sync();
  const db = database();
  try {
    if (sub === 'status') {
      return { kind: 'hii.archive.status', sources: configuration(),
        lastSync: fs.existsSync(lastSyncPath) ? JSON.parse(fs.readFileSync(lastSyncPath, 'utf8')).completedAt : null,
        counts: db.prepare('SELECT provider,COUNT(*) AS conversations FROM hii_imported_conversations GROUP BY provider').all() };
    }
    if (sub === 'search') {
      const query = args.slice(1).join(' ').trim();
      if (!query) throw new Error('usage: hii archive search <words>');
      return { kind: 'hii.archive.search', query, results: db.prepare(`SELECT c.source_id AS id,c.title,c.provider,
        snippet(hii_imported_conversations_fts,2,'[',']','…',16) AS excerpt FROM hii_imported_conversations_fts
        JOIN hii_imported_conversations c USING(source_id) WHERE hii_imported_conversations_fts MATCH ? LIMIT 20`).all(query) };
    }
    if (sub === 'show') {
      const id = args[1];
      if (!id) throw new Error('usage: hii archive show <source-id>');
      const row = db.prepare('SELECT source_id AS id,title,provider,source_path,content_hash,messages_json FROM hii_imported_conversations WHERE source_id=?').get(id);
      if (!row) throw new Error(`conversation ${id} was not imported`);
      return { ...row, messages: JSON.parse(row.messages_json), messages_json: undefined };
    }
    throw new Error('usage: hii archive connect|sync|status|search|show');
  } finally { db.close(); }
}
