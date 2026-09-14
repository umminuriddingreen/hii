// Shared local handoffs for Codex, Claude, Gemini, Hermes, and HII agents.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const runtime = process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii');
const root = path.join(runtime, 'agents', 'mailbox');
const messagesDir = path.join(root, 'messages');
const acknowledgementsDir = path.join(root, 'acks');
const agentId = (value) => {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value || '')) throw new Error('agent id must use letters, digits, dot, dash, or underscore');
  return value;
};

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1] ?? fallback;
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}

function messages() {
  if (!fs.existsSync(messagesDir)) return [];
  return fs.readdirSync(messagesDir).filter(name => name.endsWith('.json')).sort().flatMap(name => {
    try { return [JSON.parse(fs.readFileSync(path.join(messagesDir, name), 'utf8'))]; }
    catch { return []; }
  });
}

export function mailboxCommand(args) {
  const sub = args[0] || 'inbox';
  if (sub === 'send') {
    const from = agentId(option(args, '--from', process.env.HII_AGENT_ID || 'hii'));
    const to = agentId(option(args, '--to'));
    const body = option(args, '--message');
    if (!body?.trim() || body.length > 12_000) throw new Error('send needs --message with 1-12000 characters');
    const task = option(args, '--task', 'general').trim();
    if (!task || task.length > 240) throw new Error('--task must be 1-240 characters');
    const workspace = path.resolve(option(args, '--workspace', process.cwd()));
    const receipt = option(args, '--receipt');
    const contextRefs = args.flatMap((arg, index) => arg === '--context' ? [args[index + 1]] : []).filter(Boolean);
    const message = { schemaVersion: 1, kind: 'hii.agent.handoff', id: randomUUID(),
      thread: option(args, '--thread', task), from, to, task, workspace,
      contextRefs, receipt: receipt || null, body: body.trim(), createdAt: new Date().toISOString() };
    atomicJson(path.join(messagesDir, `${message.createdAt.replaceAll(':', '-')}-${message.id}.json`), message);
    return { sent: message.id, to, task, workspace, inbox: `hii agents inbox --for ${to}` };
  }
  if (sub === 'inbox') {
    const recipient = agentId(option(args, '--for', process.env.HII_AGENT_ID || 'hii'));
    const includeAcked = args.includes('--all');
    return { recipient, messages: messages().filter(message => (message.to === recipient || message.to === 'all')
      && (includeAcked || !fs.existsSync(path.join(acknowledgementsDir, message.id, `${recipient}.json`)))).slice(-100) };
  }
  if (sub === 'ack') {
    const id = args[1];
    const recipient = agentId(option(args, '--as', process.env.HII_AGENT_ID || 'hii'));
    const message = messages().find(item => item.id === id);
    if (!message || (message.to !== recipient && message.to !== 'all')) throw new Error('message not found in this agent inbox');
    atomicJson(path.join(acknowledgementsDir, id, `${recipient}.json`), { messageId: id, agent: recipient, acknowledgedAt: new Date().toISOString() });
    return { acknowledged: id, agent: recipient };
  }
  if (sub === 'thread') {
    const thread = args[1];
    if (!thread) throw new Error('usage: hii agents thread <task-or-thread-id>');
    return { thread, messages: messages().filter(message => message.thread === thread || message.task === thread) };
  }
  throw new Error('usage: hii agents send --to AGENT --task TASK --message TEXT [--from AGENT] [--workspace PATH] [--context REF] [--receipt ID] | inbox --for AGENT | ack ID --as AGENT | thread TASK');
}
