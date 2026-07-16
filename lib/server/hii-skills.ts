import 'server-only';
import { readFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { controlHiiDaemon } from '@/lib/server/hii-daemon';

export type HiiRegisteredSkill = {
  id: string;
  name: string;
  description: string;
  trustLevel: string;
  permissions: string[];
  sideEffects: string[];
  verification: string[];
  path: string;
};

type SkillRegistry = {
  skills?: Array<Record<string, unknown>>;
};

const runtime = process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii');
const registryPath = path.join(runtime, 'skills', 'registry.json');
const registeredRoot = path.join(runtime, 'skills', 'registered');

function text(value: unknown, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function textList(value: unknown, maxItems = 12) {
  return Array.isArray(value)
    ? value.map((item) => text(item, 240)).filter(Boolean).slice(0, maxItems)
    : [];
}

function normalizeSkill(value: Record<string, unknown>): HiiRegisteredSkill | null {
  const id = text(value.id, 128);
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id) || value.status !== 'registered') return null;
  return {
    id,
    name: text(value.name, 160) || id,
    description: text(value.description, 600),
    trustLevel: text(value.trustLevel, 80) || 'operator-reviewed',
    permissions: textList(value.permissions),
    sideEffects: textList(value.sideEffects),
    verification: textList(value.verification),
    path: path.join(registeredRoot, id, 'SKILL.md')
  };
}

export async function listRegisteredHiiSkills(): Promise<HiiRegisteredSkill[]> {
  try {
    const parsed = JSON.parse(await readFile(registryPath, 'utf8')) as SkillRegistry;
    const skills = await Promise.all(
      (parsed.skills || []).map(async (skill) => {
        const id = text(skill.id, 128);
        if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) return null;
        try {
          const manifest = JSON.parse(
            await readFile(path.join(registeredRoot, id, 'manifest.json'), 'utf8')
          ) as Record<string, unknown>;
          return normalizeSkill({ ...skill, ...manifest });
        } catch {
          return normalizeSkill(skill);
        }
      })
    );
    return skills
      .filter((skill): skill is HiiRegisteredSkill => Boolean(skill))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function startRegisteredHiiSkill(id: string) {
  const skill = (await listRegisteredHiiSkills()).find((item) => item.id === id);
  if (!skill) throw new Error(`Registered HII skill not found: ${id}`);

  const prompt = [
    `Run the registered HII skill ${skill.name} (${skill.id}).`,
    `Read and follow ${skill.path} as the execution contract.`,
    'Inspect live state first, preserve unrelated work, remain within the declared permissions, and produce the skill-required verification and HII receipt.',
    'Do not push, publish, spend, message, delete, or take another irreversible action without separate explicit authority.'
  ].join('\n\n');

  return controlHiiDaemon('codex.run', { prompt });
}
