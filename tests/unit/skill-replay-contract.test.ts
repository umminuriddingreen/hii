import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const server = readFileSync(resolve(root, 'lib/server/hii-skills.ts'), 'utf8');
const route = readFileSync(resolve(root, 'app/api/skills/route.ts'), 'utf8');
const pane = readFileSync(resolve(root, 'src/lib/components/workspace/GovernedCapabilityPane.svelte'), 'utf8');
const workspace = readFileSync(resolve(root, 'src/lib/components/workspace/WorkspacePage.svelte'), 'utf8');
const registry = readFileSync(resolve(root, 'aii/skills/registry.mjs'), 'utf8');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

describe('HII capability review and replay contract', () => {
  it('keeps review and replay behind separate explicit approvals', () => {
    expect(route).toContain("body?.action === 'register'");
    expect(route).toContain("body?.action === 'replay'");
    expect(route).toContain('approved: body.approved');
    expect(server).toContain("input.approved !== true");
    expect(server).toContain('Explicit operator review approval is required.');
    expect(server).toContain('Explicit replay approval is required.');
  });

  it('uses the AII registry and an append-only replay ledger', () => {
    expect(registry).toContain('export function registerSkillProposal');
    expect(server).toContain('registerSkillProposal(id, reviewedBy)');
    expect(server).toContain("'executions.jsonl'");
    expect(server).toContain('appendExecution(starting)');
    expect(server).toContain('appendExecution(queued)');
    expect(server).toContain('skillReplayReceiptIntent(replayId)');
  });

  it('shows manifest authority, receipt gating, and previous-run comparison in the workspace', () => {
    expect(workspace).toContain('GovernedCapabilityPane');
    expect(pane).toContain('Capability execution boundary');
    expect(pane).toContain('I reviewed this · register');
    expect(pane).toContain('Approve registered replay');
    expect(pane).toContain('Receipt pending. HII will not call this replay verified');
    expect(pane).toContain('Compared with previous replay');
  });

  it('adds the replay proof to product CI', () => {
    expect(packageJson.scripts['hii:skill-replay:check']).toBe(
      'node --experimental-strip-types scripts/hii-skill-replay-smoke.mjs'
    );
    expect(packageJson.scripts['ci:product']).toContain('hii:skill-replay:check');
  });
});
