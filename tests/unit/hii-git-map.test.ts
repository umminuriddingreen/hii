import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCommitMap, renderCommitMap, renderDiff, resolveSelection } from '../../scripts/hii-git-map.mjs';

function fixture() {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'hii-git-map-'));
  const run = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  run(['init', '--quiet']);
  run(['config', 'user.name', 'HII Test']);
  run(['config', 'user.email', 'hii@example.test']);
  writeFileSync(path.join(repo, 'surface.txt'), 'first\n');
  run(['add', 'surface.txt']);
  run(['commit', '--quiet', '-m', 'create surface']);
  writeFileSync(path.join(repo, 'surface.txt'), 'first\nsecond\n');
  run(['commit', '--quiet', '-am', 'extend surface']);
  return repo;
}

describe('terminal git map', () => {
  it('maps topology, time and numbered commit selections', () => {
    const repo = fixture();
    const commits = readCommitMap(repo, 10);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({ index: 1, subject: 'extend surface' });
    expect(commits[0].graph).toContain('*');
    expect(resolveSelection(commits, '2')).toBe(commits[1].hash);
    const rendered = renderCommitMap(commits, repo);
    expect(rendered).toContain('space/topology');
    expect(rendered).toContain('time (UTC)');
    expect(rendered).toContain('hii git-map diff <number|commit>');
  });

  it('renders a selected stat or full patch', () => {
    const repo = fixture();
    const commit = readCommitMap(repo, 1)[0];
    expect(renderDiff(repo, commit.hash)).toContain('surface.txt | 1 +');
    expect(renderDiff(repo, commit.hash, true)).toContain('+second');
  });
});
