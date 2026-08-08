import type { ContextSnapshot, ResolvedReference, VoiceIntent, VoiceIntentMode } from './types';

const DETERMINISTIC_SEEDS = [
  'dictate',
  'ask',
  'edit',
  'navigate',
  'act'
];

function normalizeWhitespace(value: string) {
  return value.replace(/\u0000/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripWakeWord(value: string) {
  return value
    .replace(/^\s*(?:hii|hey hii)\s+/i, '')
    .replace(/\s+(?:hii|hey hii)\s*$/i, '')
    .trim();
}

function detectBacktrack(value: string) {
  const index = value.search(/\b(?:no|actually|sorry|wait),?\s+/i);
  if (index <= 0) return null;
  const original = normalizeWhitespace(value.slice(0, index).trim());
  const final = normalizeWhitespace(value.slice(index).replace(/^\s*(?:no|actually|sorry|wait),?\s+/i, ''));
  if (!final) return null;
  return { original, final };
}

function containsDeictic(value: string) {
  return /\b(?:this|that|these|those|it|them|there|here|same thing|previous one|the other one)\b/i.test(value);
}

function classifyMode(value: string): { mode: VoiceIntentMode; confidence: number } {
  const ask = /\b(?:what|why|how|when|where|who|which|should|can you|could you|is it|are you|explain|tell me|describe|diagnose|check)\b/i;
  const navigate = /\b(?:open|go to|go into|switch to|show me|scroll|navigate|zoom|focus)\b/i;
  const edit = /\b(?:change|replace|rename|delete|remove|fix|edit|adjust|format|rewrite|move|align|resize|set|update|add|insert|select)\b/i;
  const act = /\b(?:send|message|email|text|post|publish|submit|create|run|launch|start|build|deploy|open|apply|execute|call|book|approve)\b/i;

  if (ask.test(value)) return { mode: 'ask', confidence: 0.85 };
  if (navigate.test(value)) return { mode: 'navigate', confidence: 0.8 };
  if (edit.test(value)) return { mode: 'edit', confidence: 0.76 };
  if (act.test(value)) return { mode: 'act', confidence: 0.78 };
  return { mode: 'dictate', confidence: containsDeictic(value) ? 0.58 : 0.46 };
}

function modeConfidenceGate(mode: VoiceIntentMode, hasWakeWord: boolean) {
  const seed = DETERMINISTIC_SEEDS.includes(mode) ? 0.1 : 0;
  return seed + (hasWakeWord ? 0.06 : 0);
}

function extractReferences(context: ContextSnapshot, includeSelection: boolean) {
  const references: ResolvedReference[] = [];
  if (includeSelection && context.selectedText) {
    references.push({
      source: 'SELECTION',
      objectId: context.selectedText.slice(0, 160),
      application: context.activeApp,
      confidence: 0.72,
      timestamp: context.snapshotAt
    });
  }
  if (context.activeApp) {
    references.push({
      source: 'SCREEN',
      objectId: context.activeApp,
      application: context.activeApp,
      confidence: 0.66,
      timestamp: context.snapshotAt
    });
  }
  const convo = context.conversationTurn?.trim();
  if (convo) {
    references.push({
      source: 'DISCOURSE',
      objectId: `previous-turn:${convo.slice(0, 120)}`,
      confidence: 0.48,
      timestamp: context.snapshotAt
    });
  }
  return references.slice(0, 8);
}

function dangerousAction(value: string) {
  return /\b(?:delete|remove|send|email|submit|publish|deploy|install|transfer|pay|purchase|commit|push|call|post)\b/i.test(value);
}

function modeToAction(mode: VoiceIntentMode, text: string, context: ContextSnapshot) {
  if (mode === 'dictate') {
    return undefined;
  }
  const requiresApproval = mode !== 'ask';
  return {
    capabilityId: 'hii.agent.workspace_run',
    purpose: mode === 'ask' ? 'informational-response' : `${mode} via voice intent`,
    inputs: {
      goal: text,
      projectPath: context.projectPath ?? process.cwd(),
      platform: context.platform,
      origin: 'hii.voice'
    },
    expectedOutputs: ['run artifact', 'receipt'],
    requiresApproval: requiresApproval || dangerousAction(text)
  };
}

export function interpretVoiceUtterance(
  utteranceRaw: string,
  context: ContextSnapshot
): VoiceIntent {
  const raw = normalizeWhitespace(utteranceRaw);
  const wakeRemoved = stripWakeWord(raw);
  const deNoisy = wakeRemoved.replace(/[_]+/g, ' ').trim();
  const withoutPunctuation = deNoisy.replace(/[!?]+$/g, '').trim();
  const corrected = detectBacktrack(withoutPunctuation);
  const normalizedText = corrected ? corrected.final : withoutPunctuation;
  const wakeWordUsed = raw.toLowerCase().startsWith('hii') || /(^|\s)hey hii\b/i.test(raw);
  const classification = classifyMode(withoutPunctuation);
  const references = extractReferences(context, true);
  const proposedAction = modeToAction(classification.mode, normalizedText, context);
  const approvalRequired = Boolean(
    proposedAction?.requiresApproval || /\b(?:send|publish|delete|submit|commit|push|install)\b/i.test(normalizedText)
  );
  const deterministicConfidence = Math.max(0.04, classification.confidence - modeConfidenceGate(classification.mode, wakeWordUsed));

  return {
    utterance: wakeRemoved,
    normalizedText,
    mode: classification.mode,
    confidence: Number(deterministicConfidence.toFixed(2)),
    context,
    references,
    backtrack: corrected ?? undefined,
    correctionHint: corrected ? 'final clause replaced earlier segment' : undefined,
    proposedAction,
    approvalRequired
  };
}

export function classifyVoiceEngineIntent(value: string) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return { mode: 'uncertain' as const, confidence: 0.02 };
  const normalizedLower = normalized.toLowerCase();
  if (/(send|message|email|reply|forward|attach|deliver|submit|publish|deploy)/.test(normalizedLower)) return { mode: 'act' as const, confidence: 0.86 };
  if (/(change|edit|rename|delete|remove|replace|transform|add|insert)/.test(normalizedLower)) return { mode: 'edit' as const, confidence: 0.81 };
  if (/(open|go to|navigate|switch|show|focus|return|jump|highlight|scroll)/.test(normalizedLower)) return { mode: 'navigate' as const, confidence: 0.79 };
  if (/(what|why|how|where|who|when|can i|is it|does it|explain|summarize|check)/.test(normalizedLower)) return { mode: 'ask' as const, confidence: 0.83 };
  return { mode: 'dictate' as const, confidence: 0.74 };
}

export function makeFallbackIntent(utterance: string, context: ContextSnapshot, reason?: string) {
  return {
    context,
    utterance: normalizeWhitespace(utterance),
    mode: 'uncertain' as const,
    confidence: 0.21,
    references: extractReferences(context, true),
    approvalRequired: true,
    normalizedText: normalizeWhitespace(utterance),
    correctionHint: reason
  } satisfies VoiceIntent;
}
