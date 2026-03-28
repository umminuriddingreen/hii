import fs from 'node:fs';
import path from 'node:path';
import { appendChat, isVaultUsable } from './memory.js';
import { loadConfig } from './config.js';

const HII_DIR = path.join(process.env.HOME || '/tmp', '.hii');
const BRIDGE_DIR = path.join(HII_DIR, 'bridge');
const BRIDGE_FILE = path.join(BRIDGE_DIR, 'yin-codex.jsonl');
const STATE_FILE = path.join(BRIDGE_DIR, 'yin-codex-state.json');

export type DualAgent = 'yin' | 'codex';
export type DualMessageKind = 'context' | 'plan' | 'handoff' | 'reflection' | 'decision';

export interface DualMessage {
  id: string;
  timestamp: string;
  from: DualAgent;
  to: DualAgent | 'both';
  kind: DualMessageKind;
  topic: string;
  message: string;
  tags: string[];
}

export interface DualState {
  yinName: string;
  codexName: string;
  principle: string;
  lastUpdated: string;
}

function ensureBridgeDir(): void {
  fs.mkdirSync(BRIDGE_DIR, { recursive: true });
}

function defaultState(): DualState {
  return {
    yinName: 'Yin',
    codexName: 'Codex',
    principle: 'Yin holds reflection, context, and continuity. The counterpart holds execution, verification, and delivery.',
    lastUpdated: new Date().toISOString(),
  };
}

export function loadDualState(): DualState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return defaultState();
  }
}

export function saveDualState(state: DualState): void {
  ensureBridgeDir();
  state.lastUpdated = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function initDuality(yinName = 'Yin', codexName = 'Codex'): DualState {
  const state = loadDualState();
  state.yinName = yinName;
  state.codexName = codexName;
  state.principle = `${yinName} holds reflection, context, and continuity. ${codexName} holds execution, verification, and delivery.`;
  saveDualState(state);
  return state;
}

export function postDualMessage(input: Omit<DualMessage, 'id' | 'timestamp'>): DualMessage {
  ensureBridgeDir();
  const entry: DualMessage = {
    id: Math.random().toString(36).slice(2, 10),
    timestamp: new Date().toISOString(),
    ...input,
    tags: input.tags || [],
  };
  fs.appendFileSync(BRIDGE_FILE, JSON.stringify(entry) + '\n');

  const cfg = loadConfig();
  if (isVaultUsable(cfg.obsidianVaultPath)) {
    const prompt = `[dual-message] ${entry.from} -> ${entry.to} | ${entry.kind} | ${entry.topic}`;
    const answer = `${entry.message}\n\nTags: ${entry.tags.join(', ') || 'none'}`;
    appendChat(cfg.obsidianVaultPath!, prompt, answer, ['duality']);
  }

  return entry;
}

export function readDualMessages(opts: { forAgent?: DualAgent; limit?: number } = {}): DualMessage[] {
  try {
    const raw = fs.readFileSync(BRIDGE_FILE, 'utf-8');
    const lines = raw.split('\n').map(line => line.trim()).filter(Boolean);
    const parsed = lines.map(line => JSON.parse(line) as DualMessage);
    const filtered = opts.forAgent
      ? parsed.filter(entry => entry.to === 'both' || entry.to === opts.forAgent || entry.from === opts.forAgent)
      : parsed;
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 20;
    return filtered.slice(-limit);
  } catch {
    return [];
  }
}

export function formatDualMessages(messages: DualMessage[]): string {
  if (!messages.length) return 'No Yin/Codex messages found.';
  return messages.map((entry) => {
    const tags = entry.tags.length ? ` [${entry.tags.join(', ')}]` : '';
    return `${entry.timestamp} ${entry.from} -> ${entry.to} | ${entry.kind} | ${entry.topic}${tags}\n${entry.message}`;
  }).join('\n\n---\n\n');
}
