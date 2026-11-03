import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { ContextSnapshot, ResolvedReference } from './types';

const execFileAsync = promisify(execFile);

function platformName() {
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'linux') return 'linux';
  return 'unknown';
}

function sanitizeText(value: unknown, max = 280) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

async function macActiveApplication() {
  const script = [
    'tell application "System Events"',
    'set frontApp to name of first application process whose frontmost is true',
    'return frontApp',
    'end tell'
  ].join('\n');

  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script]);
    return sanitizeText(stdout, 120);
  } catch {
    return '';
  }
}

async function macActiveWindowTitle() {
  const script = [
    'tell application "System Events"',
    'set frontApp to first application process whose frontmost is true',
    'if (count of windows of frontApp) > 0 then',
    'set frontWin to front window of frontApp',
    'try',
    'return name of frontWin',
    'on error',
    'return ""',
    'end try',
    'end if',
    'return ""',
    'end tell'
  ].join('\n');

  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script]);
    return sanitizeText(stdout, 240);
  } catch {
    return '';
  }
}

function defaultRecentContext() {
  return '';
}

function defaultProjectPath() {
  return process.cwd().trim();
}

function runtimePath() {
  return process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii');
}

function recentConversationTurn() {
  const voiceDir = path.join(runtimePath(), 'voice');
  const conversations = path.join(voiceDir, 'conversations.jsonl');
  return fs
    .readFile(conversations, 'utf8')
    .then((text) =>
      text
        .trim()
        .split('\n')
        .filter(Boolean)
        .slice(-1)
        .map((line) => {
          try {
            return JSON.parse(line) as { text?: string };
          } catch {
            return null;
          }
        })
        .find(Boolean) as { text?: string } | undefined
    )
    .then((entry) => sanitizeText(entry?.text, 240))
    .catch(() => '');
}

export async function buildVoiceContextSnapshot(references: ResolvedReference[] = []) {
  const [activeApp, activeWindow, conversationTurn] = await Promise.all([
    platformName() === 'mac' ? macActiveApplication() : Promise.resolve(''),
    platformName() === 'mac' ? macActiveWindowTitle() : Promise.resolve(''),
    recentConversationTurn()
  ]);

  return {
    snapshotAt: new Date().toISOString(),
    activeApp,
    activeWindow,
    conversationTurn,
    projectPath: defaultProjectPath(),
    platform: platformName(),
    recentCommandSummary: defaultRecentContext(),
    references: references.length ? references.slice(0, 12) : []
  } satisfies ContextSnapshot;
}

export function normalizeContextReferences(value: unknown[]): ResolvedReference[] {
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const raw = entry as Partial<ResolvedReference> & { source?: string; confidence?: unknown };
      const source = String(raw.source || '').toUpperCase();
      const validSource = [
        'POINTER',
        'SELECTION',
        'SCREEN',
        'MEMORY',
        'DISCOURSE'
      ].includes(source)
      ? (source as ResolvedReference['source'])
      : null;
      if (!validSource) return null;
      const objectId = sanitizeText(raw.objectId, 180);
      if (!objectId) return null;
      const confidence = Number(raw.confidence);
      const normalizedConfidence = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5;
      const timestamp = sanitizeText(raw.timestamp, 40) || new Date().toISOString();
      return {
        source: validSource,
        objectId,
        confidence: normalizedConfidence,
        timestamp,
        application: sanitizeText(raw.application, 120) || undefined,
        contextHint: sanitizeText(raw.contextHint, 180) || undefined
      } as ResolvedReference;
    })
    .filter((entry): entry is ResolvedReference => entry !== null);
}
