import 'server-only';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerSkillProposal } from '../../runtime/skills/registry.mjs';
import {
  compareSkillReplays,
  latestSkillExecutionEvents,
  skillReplayReceiptIntent,
  summarizeSkillReplay,
  type SkillActionReceipt,
  type SkillExecutionEvent
} from '../skills/replay.ts';
import { controlHiiDaemon, getHiiDaemonRun } from './hii-daemon';

export type HiiSkillDetail = {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'registered';
  trustLevel: string;
  permissions: string[];
  sideEffects: string[];
  verification: string[];
  sourceReceiptIds: string[];
  observations: number;
  reviewedBy: string | null;
  registeredAt: string | null;
  path: string;
};

export type HiiRegisteredSkill = HiiSkillDetail & {
  status: 'registered';
};

type SkillRegistry = {
  skills?: Array<Record<string, unknown>>;
};

function runtimeRoot() {
  return process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii');
}

function skillsRoot() {
  return path.join(runtimeRoot(), 'skills');
}

function registryPath() {
  return path.join(skillsRoot(), 'registry.json');
}

function skillFolder(status: 'draft' | 'registered', id: string) {
  return path.join(skillsRoot(), status === 'registered' ? 'registered' : 'proposed', id);
}

function executionPath() {
  return path.join(skillsRoot(), 'executions.jsonl');
}

function actionReceiptsPath() {
  return path.join(skillsRoot(), 'actions.jsonl');
}

function text(value: unknown, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function textList(value: unknown, maxItems = 24) {
  return Array.isArray(value)
    ? value.map((item) => text(item, 1000)).filter(Boolean).slice(0, maxItems)
    : [];
}

function validSkillId(value: unknown) {
  const id = text(value, 128);
  return /^[a-z0-9][a-z0-9-]*$/.test(id) ? id : '';
}

function normalizeSkill(
  value: Record<string, unknown>,
  fallbackStatus?: 'draft' | 'registered'
): HiiSkillDetail | null {
  const id = validSkillId(value.id);
  const status = value.status === 'registered' ? 'registered' : value.status === 'draft' ? 'draft' : fallbackStatus;
  if (!id || !status) return null;
  return {
    id,
    name: text(value.name, 160) || id,
    description: text(value.description, 1200),
    status,
    trustLevel: text(value.trustLevel, 80) || (status === 'registered' ? 'operator-reviewed' : 'draft'),
    permissions: textList(value.permissions),
    sideEffects: textList(value.sideEffects),
    verification: textList(value.verification),
    sourceReceiptIds: textList(value.sourceReceiptIds, 100),
    observations: Math.max(0, Math.floor(Number(value.observations) || textList(value.sourceReceiptIds, 100).length)),
    reviewedBy: text(value.reviewedBy, 160) || null,
    registeredAt: text(value.registeredAt, 80) || null,
    path: path.join(skillFolder(status, id), 'SKILL.md')
  };
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    return (await readFile(file, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as T;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is T => entry !== null);
  } catch {
    return [];
  }
}

async function manifestSkill(id: string, status: 'draft' | 'registered') {
  const manifest = await readJson<Record<string, unknown> | null>(
    path.join(skillFolder(status, id), 'manifest.json'),
    null
  );
  return manifest ? normalizeSkill(manifest, status) : null;
}

export async function listRegisteredHiiSkills(): Promise<HiiRegisteredSkill[]> {
  const parsed = await readJson<SkillRegistry>(registryPath(), { skills: [] });
  const skills = await Promise.all(
    (parsed.skills || []).map(async (skill) => {
      const id = validSkillId(skill.id);
      if (!id) return null;
      return (await manifestSkill(id, 'registered')) || normalizeSkill(skill, 'registered');
    })
  );
  return skills
    .filter((skill): skill is HiiRegisteredSkill => Boolean(skill && skill.status === 'registered'))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getHiiSkillDetail(idValue: unknown) {
  const id = validSkillId(idValue);
  if (!id) throw new Error('A valid HII skill id is required.');
  return (await manifestSkill(id, 'registered')) || (await manifestSkill(id, 'draft'));
}

async function appendExecution(event: SkillExecutionEvent) {
  await mkdir(skillsRoot(), { recursive: true });
  await appendFile(executionPath(), `${JSON.stringify(event)}\n`, 'utf8');
}

export async function listHiiSkillReplays(idValue: unknown) {
  const id = validSkillId(idValue);
  if (!id) throw new Error('A valid HII skill id is required.');
  const [events, receipts] = await Promise.all([
    readJsonl<SkillExecutionEvent>(executionPath()),
    readJsonl<SkillActionReceipt>(actionReceiptsPath())
  ]);
  const executions = latestSkillExecutionEvents(events.filter((event) => event.skillId === id)).slice(0, 12);
  const replays = await Promise.all(
    executions.map(async (execution) => {
      const run = execution.daemonRunId ? await getHiiDaemonRun(execution.daemonRunId) : null;
      return summarizeSkillReplay(execution, run, receipts);
    })
  );
  return {
    replays,
    comparison: replays.length ? compareSkillReplays(replays[0], replays[1] || null) : null
  };
}

export async function getHiiSkillReplayDetail(idValue: unknown) {
  const skill = await getHiiSkillDetail(idValue);
  if (!skill) return null;
  const history = skill.status === 'registered'
    ? await listHiiSkillReplays(skill.id)
    : { replays: [], comparison: null };
  return { skill, ...history };
}

export async function registerHiiSkillDraft(input: {
  id?: unknown;
  reviewedBy?: unknown;
  approved?: unknown;
}) {
  if (input.approved !== true) throw new Error('Explicit operator review approval is required.');
  const id = validSkillId(input.id);
  const reviewedBy = text(input.reviewedBy, 160);
  if (!id || !reviewedBy) throw new Error('A draft skill id and reviewer name are required.');
  const draft = await manifestSkill(id, 'draft');
  if (!draft) throw new Error(`HII skill draft not found: ${id}`);
  if (!draft.verification.length && !draft.sourceReceiptIds.length) {
    throw new Error('Registration requires verification or a source receipt.');
  }
  registerSkillProposal(id, reviewedBy);
  const skill = await manifestSkill(id, 'registered');
  if (!skill || skill.status !== 'registered') throw new Error('HII could not verify skill registration.');
  return skill;
}

export async function startRegisteredHiiSkill(input: {
  id?: unknown;
  approved?: unknown;
}) {
  if (input.approved !== true) throw new Error('Explicit replay approval is required.');
  const id = validSkillId(input.id);
  const skill = (await listRegisteredHiiSkills()).find((item) => item.id === id);
  if (!skill) throw new Error(`Registered HII skill not found: ${id}`);

  const replayId = randomUUID();
  const startedAt = new Date().toISOString();
  const starting: SkillExecutionEvent = {
    id: replayId,
    skillId: skill.id,
    daemonRunId: null,
    status: 'starting',
    startedAt,
    updatedAt: startedAt
  };
  await appendExecution(starting);
  const receiptIntent = skillReplayReceiptIntent(replayId);
  const prompt = [
    `Run the registered HII skill ${skill.name} (${skill.id}).`,
    `HII replay id: ${replayId}`,
    `Read and follow ${skill.path} as the execution contract.`,
    `Declared permissions: ${skill.permissions.join('; ') || 'No additional permissions declared.'}`,
    `Declared side effects: ${skill.sideEffects.join('; ') || 'No side effects declared.'}`,
    `Required verification: ${skill.verification.join('; ') || 'Return task-appropriate proof.'}`,
    'Inspect live state first, preserve unrelated work, remain within the declared permissions, and produce the skill-required verification.',
    `After verification, record one HII action receipt whose intent is exactly "${receiptIntent}". Do not mark the receipt repeatable; this registered skill remains operator-reviewed.`,
    'Do not push, publish, spend, message, delete, or take another irreversible action without separate explicit authority.'
  ].join('\n\n');

  try {
    const result = await controlHiiDaemon('codex.run', { prompt });
    if (!result.runId) throw new Error('HII did not return a managed replay run id.');
    const queued: SkillExecutionEvent = {
      ...starting,
      daemonRunId: result.runId,
      status: 'queued',
      updatedAt: new Date().toISOString()
    };
    await appendExecution(queued);
    return { ...result, replay: queued };
  } catch (cause) {
    const failed: SkillExecutionEvent = {
      ...starting,
      status: 'failed',
      updatedAt: new Date().toISOString(),
      error: cause instanceof Error ? cause.message : 'Could not start the registered skill replay.'
    };
    await appendExecution(failed);
    throw cause;
  }
}
