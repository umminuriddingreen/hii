import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const learner = readFileSync(path.join(root, 'src/routes/learn/+page.svelte'), 'utf8');

describe('HII Learner public artifact', () => {
  it('teaches the verified-work loop without claiming a run occurred', () => {
    expect(learner).toContain('guided demo · no agent runs on this page');
    expect(learner).toContain('Nothing runs until you approve it.');
    expect(learner).toContain('A receipt shows what happened');
    expect(learner).toContain('/activate?mock=1');
  });

  it('connects the learner story to the founder thesis and pilot', () => {
    expect(learner).toContain('The pen made');
    expect(learner).toContain('The people’s AI tool');
    expect(learner).toContain('Bring one real task to the founder pilot');
  });
});
