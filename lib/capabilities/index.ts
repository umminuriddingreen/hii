import fs from 'fs';
import path from 'path';
import os from 'os';
import type { CapabilityDefinition } from './types';

// Thin read client per docs/aii-hii-boundary.md: the capability registry is
// AII-owned data. AII (hiid) publishes it to ~/.hii/capabilities.json; HII
// reads that file and falls back to the in-repo AII source when the daemon
// hasn't published yet. No AII code is imported here.
const publishedPath = path.join(
  process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii'),
  'capabilities.json'
);
const aiiSourcePath = path.join(process.cwd(), 'aii', 'capabilities', 'registry.json');

let cached: CapabilityDefinition[] | null = null;

function readRegistry(): CapabilityDefinition[] {
  for (const file of [publishedPath, aiiSourcePath]) {
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
