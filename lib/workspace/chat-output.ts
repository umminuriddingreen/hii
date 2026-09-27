import { visibleRunOutput } from './run-output.ts';

export type WorkspaceChatPresentation = {
  text: string;
  raw: string | null;
  legacyTranscript: boolean;
};

const rawTranscriptMarkers = [
  'Reading additional input from stdin...',
  'OpenAI Codex v',
  'tokens used',
  'codex_models_manager::cache',
  'rmcp::transport::worker',
  '--------\nworkdir:'
];

function containsRawTranscript(text: string) {
  if (text.includes('Reading additional input from stdin...')) return true;
  return rawTranscriptMarkers.filter((marker) => text.includes(marker)).length >= 2;
}

export function workspaceChatPresentation(
  role: 'user' | 'assistant',
  text: string
): WorkspaceChatPresentation {
  if (role === 'user' || !containsRawTranscript(text)) {
    return { text, raw: null, legacyTranscript: false };
  }

  const visible = visibleRunOutput(text).trim();
  return {
    text: visible || 'This older managed run did not return a readable assistant response.',
    raw: text,
    legacyTranscript: true
  };
}

export function workspaceChatStatusLabel(status?: string) {
  if (status === 'queued') return 'Accepted by HII';
  if (status === 'running') return 'Working locally';
  if (status === 'completed') return 'Run complete';
  if (status === 'failed') return 'Needs attention';
  if (status === 'stopped' || status === 'cancelled') return 'Run stopped';
  return status ? status.replaceAll('_', ' ') : '';
}
