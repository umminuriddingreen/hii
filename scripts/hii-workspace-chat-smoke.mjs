import assert from 'node:assert/strict';

const {
  workspaceChatPresentation,
  workspaceChatStatusLabel
} = await import('../lib/workspace/chat-output.ts');

const legacyTranscript = [
  'Reading additional input from stdin...',
  '2026-07-19T10:08:30.022Z ERROR codex_models_manager::cache: stale cache',
  'OpenAI Codex v0.144.6',
  '--------',
  'workdir: /Users/ummi/hii',
  'user',
  'hello',
  'codex',
  'The readable response is ready.',
  'tokens used',
  '1,234',
  'The readable response is ready.'
].join('\n');
const legacy = workspaceChatPresentation('assistant', legacyTranscript);

assert.equal(legacy.text, 'The readable response is ready.');
assert.equal(legacy.raw, legacyTranscript);
assert.equal(legacy.legacyTranscript, true);
assert.deepEqual(
  workspaceChatPresentation('assistant', 'OpenAI Codex v1 is ordinary assistant prose.'),
  { text: 'OpenAI Codex v1 is ordinary assistant prose.', raw: null, legacyTranscript: false }
);
assert.deepEqual(
  workspaceChatPresentation('user', 'OpenAI Codex v1 is part of my question.'),
  { text: 'OpenAI Codex v1 is part of my question.', raw: null, legacyTranscript: false }
);
assert.equal(workspaceChatStatusLabel('queued'), 'Accepted by AII');
assert.equal(workspaceChatStatusLabel('running'), 'Working locally');
assert.equal(workspaceChatStatusLabel('completed'), 'Run complete');
assert.equal(workspaceChatStatusLabel('failed'), 'Needs attention');

console.log('HII workspace managed chat smoke');
console.log('status:       ok');
console.log('presentation: readable assistant response remains primary');
console.log('evidence:     legacy raw transcript remains available for explicit inspection');
console.log('states:       AII run lifecycle uses human-facing labels');
console.log('persistence:  stored human and assistant message text is not rewritten');
