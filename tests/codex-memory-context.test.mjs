import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test, { afterEach, describe } from 'node:test';
import {
  buildCodexMemoryPack,
  codexExecInvocation,
  estimateTokens
} from '../runtime/daemon/codex-memory.mjs';

const temporary = [];

function memoryFile(content) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hii-codex-memory-'));
  temporary.push(directory);
  const file = path.join(directory, 'MEMORY.md');
  fs.writeFileSync(file, content);
  return file;
}

afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('bounded Codex memory context', () => {
  test('keeps Codex native memories when HII cannot produce a pack', () => {
    const pack = buildCodexMemoryPack({
      prompt: 'repair context retrieval',
      coordinate: '/workspace',
      memoryFile: '/missing/MEMORY.md'
    });
    const invocation = codexExecInvocation({ prompt: 'repair context retrieval', coordinate: '/workspace', memoryPack: pack });

    assert.equal(pack.ok, false);
    assert.equal(pack.reason, 'memory-file-missing');
    assert.equal(invocation.args.includes('memories'), false);
    assert.equal(invocation.effectivePrompt, 'repair context retrieval');
  });

  test('allows the operator to disable HII retrieval without reading memory', () => {
    const pack = buildCodexMemoryPack({
      prompt: 'repair context retrieval',
      coordinate: '/workspace',
      memoryFile: '/missing/MEMORY.md',
      tokenBudget: 0
    });

    assert.equal(pack.ok, false);
    assert.equal(pack.reason, 'hii-memory-disabled');
    assert.equal(pack.tokenBudget, 0);
  });

  test('selects relevant sections with line provenance and redacts credential-shaped values', () => {
    const file = memoryFile([
      '# Task Group: Garden planning',
      'Tomatoes need afternoon shade.',
      '',
      '# Task Group: Codex context budgeting',
      'scope: reduce redundant prompt context with deterministic retrieval.',
      'access_token=secret-value',
      'Preserve provenance for every selected memory section.',
      '',
      '# Task Group: Music export',
      'Normalize the final mix.'
    ].join('\n'));
    const pack = buildCodexMemoryPack({
      prompt: 'make Codex context retrieval token efficient and preserve provenance',
      coordinate: '/Users/ummi/hii',
      memoryFile: file,
      tokenBudget: 320
    });

    assert.equal(pack.ok, true);
    assert.match(pack.text, /Codex context budgeting/);
    assert.match(pack.text, /MEMORY\.md:L4-L\d+/);
    assert.match(pack.text, /access_token=\[redacted\]/);
    assert.doesNotMatch(pack.text, /secret-value|Tomatoes/);
    assert.ok(pack.estimatedTokens <= 320);
  });

  test('is deterministic, deduplicates repeated content, and stays under its token budget', () => {
    const repeated = '# Task Group: Token discipline\nFocused retrieval avoids redundant context.\n';
    const file = memoryFile(`${repeated}\n${repeated}\n# Task Group: Other\nUnrelated material.`);
    const input = {
      prompt: 'focused token retrieval',
      coordinate: '/workspace',
      memoryFile: file,
      tokenBudget: 180
    };
    const first = buildCodexMemoryPack(input);
    const second = buildCodexMemoryPack(input);

    assert.deepEqual(first, second);
    assert.equal(first.ok, true);
    assert.equal(first.selected.length, 1);
    assert.ok(estimateTokens(first.text) <= 180);
  });

  test('shrinks a large registry to a focused pack before disabling Codex memories', () => {
    const irrelevant = Array.from({ length: 500 }, (_, index) =>
      `# Task Group: Archive ${index}\nHistorical landscape note ${index} with no active routing terms.`
    ).join('\n\n');
    const source = `${irrelevant}\n\n# Task Group: Fast context pipeline\nDeterministic token budgeting and provenance for focused retrieval.`;
    const file = memoryFile(source);
    const pack = buildCodexMemoryPack({
      prompt: 'implement deterministic token budgeting for the context pipeline',
      coordinate: '/workspace',
      memoryFile: file,
      tokenBudget: 220
    });
    const invocation = codexExecInvocation({ prompt: 'implement pipeline', coordinate: '/workspace', memoryPack: pack });

    assert.equal(pack.ok, true);
    assert.match(pack.text, /Fast context pipeline/);
    assert.ok(Buffer.byteLength(source) > Buffer.byteLength(pack.text) * 50);
    assert.deepEqual(invocation.args.slice(0, 3), ['exec', '--disable', 'memories']);
    assert.match(invocation.effectivePrompt, /<HII_MEMORY_CONTEXT version="1">/);
    assert.equal(invocation.usesHiiMemory, true);
  });
});
