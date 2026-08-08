import type { ResolvedReference } from './types';

const PROJECT_TOKENS = [
  'hii',
  'voice',
  'agent',
  'workspace',
  'context'
];

export type VocabularyScope = 'global' | 'workspace' | 'repo' | 'conversation';

export type VocabularyItem = {
  text: string;
  scope: VocabularyScope;
  confidence: number;
};

function sanitizeTerm(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function unique(items: VocabularyItem[]) {
  const byText = new Map<string, VocabularyItem>();
  for (const item of items) {
    const next = byText.get(item.text);
    if (!next || item.confidence > next.confidence) {
      byText.set(item.text, item);
    }
  }
  return Array.from(byText.values());
}

function fromReference(reference: ResolvedReference) {
  const text = sanitizeTerm(reference.objectId || '');
  if (!text) return [];
  return [{ text, scope: 'conversation' as const, confidence: reference.confidence }];
}

export function assembleVoiceVocabulary(payload: {
  global?: string[];
  workspace?: string[];
  repo?: string[];
  conversationReferences?: ResolvedReference[];
}) {
  const base = [
    ...PROJECT_TOKENS,
    ...(payload.global ?? []),
    ...(payload.workspace ?? []),
    ...(payload.repo ?? [])
  ].map((token) => ({ text: sanitizeTerm(token), scope: 'global' as const, confidence: 0.82 }));

  const mappedReferences: VocabularyItem[] = (payload.conversationReferences ?? []).flatMap(fromReference).map((item) => ({
    ...item,
    confidence: Math.max(0.28, Math.min(1, item.confidence))
  }));
  return unique([...base, ...mappedReferences]).filter((item) => item.text.length >= 2);
}
