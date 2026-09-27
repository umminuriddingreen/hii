import fs from 'fs';
import path from 'path';
import os from 'os';
import type { CapabilityDefinition } from './types';

// Thin read client per docs/aii-hii-boundary.md: the capability registry is
// HII-owned data. HII (hiid) publishes it to ~/.hii/capabilities.json; HII
// reads that file and falls back to the in-repo runtime source when the daemon
// hasn't published yet. No execution code is imported here.
const publishedPath = path.join(
  process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii'),
  'capabilities.json'
);
const runtimeSourcePath = path.join(process.cwd(), 'runtime', 'capabilities', 'registry.json');

let cached: CapabilityDefinition[] | null = null;

function readRegistry(): CapabilityDefinition[] {
  for (const file of [publishedPath, runtimeSourcePath]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) return parsed as CapabilityDefinition[];
    } catch {
      /* try next source */
    }
  }
  return [];
}

export function listCapabilities() {
  if (!cached) cached = readRegistry();
  return cached;
}

export function getCapability(id: string) {
  return listCapabilities().find((capability) => capability.id === id) ?? null;
}

export function requireCapability(id: string) {
  const capability = getCapability(id);
  if (!capability) throw new Error(`Unknown capability: ${id}`);
  return capability;
}
