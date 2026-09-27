import { describe, expect, it } from 'vitest';
import { workspaceChatPresentation, workspaceChatStatusLabel } from '../../lib/workspace/chat-output';

describe('workspace managed chat presentation', () => {
  it('extracts the readable assistant response from a legacy Codex transcript', () => {
    const raw = [
      'Reading additional input from stdin...',
      '2026-07-19T10:08:30.022Z ERROR codex_models_manager::cache: stale cache',
      'OpenAI Codex v0.144.6',
      '--------',
      'workdir: /Users/ummi/hii',
      'user',
      'hello',
      'codex',
      'Hello! What are we working on today?',
      'tokens used',
      '1,234',
      'Hello! What are we working on today?'
    ].join('\n');

    expect(workspaceChatPresentation('assistant', raw)).toEqual({
      text: 'Hello! What are we working on today?',
      raw,
      legacyTranscript: true
    });
  });

  it('does not alter human messages or ordinary assistant prose', () => {
    expect(workspaceChatPresentation('user', 'OpenAI Codex v1 is useful.')).toEqual({
      text: 'OpenAI Codex v1 is useful.',
      raw: null,
      legacyTranscript: false
    });
    expect(workspaceChatPresentation('assistant', 'A clear answer.')).toEqual({
      text: 'A clear answer.',
      raw: null,
      legacyTranscript: false
    });
    expect(workspaceChatPresentation('assistant', 'OpenAI Codex v1 is the version I reviewed.')).toEqual({
      text: 'OpenAI Codex v1 is the version I reviewed.',
      raw: null,
      legacyTranscript: false
    });
  });

  it('keeps unreadable legacy evidence inspectable without presenting it as an answer', () => {
    const raw = 'Reading additional input from stdin...\nOpenAI Codex v1\nuser\nprivate prompt';
    expect(workspaceChatPresentation('assistant', raw)).toEqual({
      text: 'This older managed run did not return a readable assistant response.',
      raw,
      legacyTranscript: true
    });
  });

  it('translates runner states into human-facing labels', () => {
    expect(workspaceChatStatusLabel('queued')).toBe('Accepted by HII');
    expect(workspaceChatStatusLabel('running')).toBe('Working locally');
    expect(workspaceChatStatusLabel('completed')).toBe('Run complete');
    expect(workspaceChatStatusLabel('failed')).toBe('Needs attention');
    expect(workspaceChatStatusLabel('cancelled')).toBe('Run stopped');
  });
});
