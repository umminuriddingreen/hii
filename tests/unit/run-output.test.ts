import { describe, expect, it } from 'vitest';
import { visibleRunOutput } from '../../lib/workspace/run-output';

describe('managed run visible output', () => {
  it('returns the final answer after the Codex token receipt', () => {
    const log = [
      'OpenAI Codex v1',
      'codex',
      'I am checking the workspace.',
      'exec',
      '/bin/zsh -lc pwd',
      'codex',
      'The verified result is ready.',
      'tokens used',
      '1,234',
      'The verified result is ready.'
    ].join('\n');

    expect(visibleRunOutput(log)).toBe('The verified result is ready.');
  });

  it('streams only the latest Codex-authored block while tools are running', () => {
    const log = [
      'codex',
      'Earlier status.',
      'exec',
      'npm test',
      'passed',
      'codex',
      'The first live paragraph',
      'is still arriving.'
    ].join('\n');

    expect(visibleRunOutput(log)).toBe('The first live paragraph\nis still arriving.');
  });

  it('strips terminal controls and bounds fallback output', () => {
    expect(visibleRunOutput('\u001b[32mcodex\u001b[0m\nClean response')).toBe('Clean response');
    expect(visibleRunOutput('startup warning\nOpenAI Codex v1\nuser\nPrivate prompt')).toBe('');
    expect(visibleRunOutput('0123456789', 4)).toBe('6789');
  });
});
