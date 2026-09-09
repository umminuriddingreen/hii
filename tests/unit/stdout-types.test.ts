// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { describe, expect, it } from 'vitest';
import { artifactsFromOutput, classifyStdout, seedsFromRunOutput } from '@/lib/workspace/stdout-types';

/**
 * Classification only earns its place if it is conservative.
 *
 * A table drawn from prose, or a sentence read as a saved file, presents a
 * guess as something the system observed — the exact failure mode receipts
 * exist to prevent. So the load-bearing assertions here are the negative ones:
 * ordinary output must stay `text`.
 */

describe('stdout classification', () => {
  it('leaves prose as text', () => {
    const prose = [
      'I looked through the receipts and found three runs from yesterday.',
      'Two of them completed and one was cancelled before it started.',
      'Let me know if you want the details.'
    ].join('\n');

    expect(classifyStdout(prose).type).toBe('text');
    expect(artifactsFromOutput(prose)).toEqual([]);
  });

  it('does not read an aligned sentence as a table', () => {
    const aligned = 'Name    Age\nonly one row follows this header';
    expect(classifyStdout(aligned).type).toBe('text');
  });

  it('reads a real table as a table', () => {
    const table = 'name\tstatus\tms\nbuild\tok\t812\ntest\tok\t1203\nlint\tfail\t44';
    const chunk = classifyStdout(table);

    expect(chunk.type).toBe('table');
    expect((chunk.value as string[][])[0]).toEqual(['name', 'status', 'ms']);
    expect((chunk.value as string[][])).toHaveLength(4);
    // The log is never replaced by the parse.
    expect(chunk.raw).toBe(table);
  });

  it('trusts the stream over the prose when marking an error', () => {
    expect(classifyStdout('everything is fine', 'stderr').type).toBe('error');
    // …and still catches an error a program wrote to stdout.
    expect(classifyStdout('Traceback (most recent call last):\n  File "a.py"').type).toBe('error');
  });

  it('finds artifacts a run announced, in order and without duplicates', () => {
    const output = [
      'rendering…',
      'wrote: out/daylight.png',
      'saved -> out/mesh.glb',
      'wrote: out/daylight.png',
      'done in 4.1s'
    ].join('\n');

    const artifacts = artifactsFromOutput(output);
    expect(artifacts.map((artifact) => artifact.path)).toEqual(['out/daylight.png', 'out/mesh.glb']);
    expect(artifacts.map((artifact) => artifact.type)).toEqual(['image', 'geometry']);
  });

  it('carries lineage onto every captured artifact', () => {
    const seeds = seedsFromRunOutput({
      output: 'wrote: out/metrics.csv',
      command: 'python daylight.py',
      runId: 'run-7',
      receiptPath: '.hii/receipts/run-7.json'
    });

    expect(seeds).toHaveLength(1);
    // An artifact that cannot say which run produced it is just a file.
    expect(seeds[0].object).toMatchObject({
      kind: 'artifact',
      owner: 'agent',
      runId: 'run-7',
      proofRefs: ['.hii/receipts/run-7.json'],
      source: 'stdout of `python daylight.py`'
    });
    expect(seeds[0].payload).toMatchObject({ path: 'out/metrics.csv', producedBy: 'python daylight.py' });
  });
});
