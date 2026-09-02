import { projectEmbeddingsWithPca, projectMockSemantics, stableUnit } from './projection';
import type { AttentionEdge, InferenceRuntimeAdapter, InferenceState, TokenCandidate, TokenVisual } from './types';

const DEMO_SEQUENCE = ['with', 'broad', 'openings', 'oriented', 'toward', 'a', 'sheltered', 'courtyard'];
const PROTOTYPE_PROMPT = 'Design a small concrete house beside the ocean.';

const CANDIDATES: Record<string, TokenCandidate[]> = {
  with: [
    { text: 'with', probability: 0.42 },
    { text: 'that', probability: 0.21 },
    { text: 'using', probability: 0.14 },
    { text: 'overlooking', probability: 0.08 },
  ],
  broad: [
    { text: 'broad', probability: 0.38 },
    { text: 'large', probability: 0.23 },
    { text: 'deep', probability: 0.13 },
    { text: 'framed', probability: 0.09 },
  ],
  openings: [
    { text: 'openings', probability: 0.47 },
    { text: 'windows', probability: 0.24 },
    { text: 'views', probability: 0.12 },
    { text: 'terraces', probability: 0.07 },
  ],
};

export function tokenizeVisible(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu) || [];
}

export function createInferenceRuntime(prompt = PROTOTYPE_PROMPT): InferenceRuntimeAdapter {
  return new DeterministicInferenceRuntime(prompt);
}

export function selectVisibleTokens(tokens: TokenVisual[], selectedIds: string[] = []): TokenVisual[] {
  if (tokens.length <= 200) return tokens;
  const chosen = new Map<string, TokenVisual>();
  const keep = (token: TokenVisual | undefined) => { if (token && chosen.size < 200) chosen.set(token.id, token); };
  const selected = new Set(selectedIds);
  tokens.filter((token) => selected.has(token.id)).forEach(keep);
  tokens.slice(-72).forEach(keep);
  [...tokens].sort((a, b) => (b.influence || 0) - (a.influence || 0)).slice(0, 88).forEach(keep);
  const remaining = Math.max(0, 200 - chosen.size);
  const stride = Math.max(1, Math.floor(tokens.length / Math.max(1, remaining)));
  for (let index = 0; index < tokens.length && chosen.size < 200; index += stride) keep(tokens[index]);
  for (const token of tokens) keep(token);
  return [...chosen.values()].sort((a, b) => tokens.indexOf(a) - tokens.indexOf(b));
}

class DeterministicInferenceRuntime implements InferenceRuntimeAdapter {
  private prompt: string;
  private current: InferenceState;
  private elapsed = 0;
  private cycleElapsed = 0;
  private generatedIndex = 0;
  private generatedStartedAt = 0;
  private outputSnapshot = '';
  private observedQueue: string[] = [];
  private insertedObserved = 0;
  private toolElapsed: number | null = null;
  private liveToolHold: number | null = null;

  constructor(prompt: string) {
    this.prompt = prompt.trim() || PROTOTYPE_PROMPT;
    this.current = this.initialState();
  }

  state() {
    return cloneState(this.current);
  }

  advance(deltaMs: number) {
    if (this.current.paused) return this.state();
    const boundedDelta = Math.max(0, Math.min(deltaMs, 100));
    this.elapsed += boundedDelta;

    if (this.liveToolHold !== null) {
      if (this.liveToolHold < 0) return this.state();
      this.liveToolHold -= boundedDelta;
      if (this.liveToolHold <= 0) {
        this.returnToolObservation(this.current.toolEvent?.detail || 'observation');
        this.liveToolHold = null;
      }
      return this.state();
    }

    if (this.toolElapsed !== null) {
      this.toolElapsed += boundedDelta;
      this.advanceTool();
      return this.state();
    }

    if (this.elapsed < 720) {
      this.current.phase = 'reading';
      this.current.activeTokenIds = this.current.contextTokens
        .slice(0, Math.max(1, Math.floor((this.elapsed / 720) * this.current.contextTokens.length)))
        .map((token) => token.id);
      this.updateInfluence();
      return this.state();
    }
    if (this.elapsed < 1_560) {
      this.current.phase = 'computing';
      this.updateInfluence();
      this.current.attentionEdges = strongestEdges(this.current.contextTokens, this.elapsed);
      return this.state();
    }

    this.cycleElapsed += boundedDelta;
    const selectedText = this.nextGeneratedText();
    if (!selectedText) {
      this.current.phase = 'computing';
      this.current.candidates = [];
      this.current.generatedToken = undefined;
      this.updateInfluence();
      return this.state();
    }

    const within = this.cycleElapsed % 1_280;
    if (within < 360) {
      this.current.phase = 'computing';
      this.current.candidates = [];
      this.current.generatedToken = undefined;
    } else if (within < 930) {
      this.current.phase = 'generating';
      this.current.candidates = candidatesFor(selectedText);
      this.current.generatedToken = undefined;
    } else if (!this.current.generatedToken) {
      const token = this.makeGeneratedToken(selectedText);
      this.current.generatedToken = token;
      this.current.candidates = candidatesFor(selectedText);
    }

    if (within >= 1_150 && this.current.generatedToken) {
      this.current.contextTokens = selectVisibleTokens([...this.current.contextTokens, this.current.generatedToken], this.current.activeTokenIds);
      this.current.generatedToken = undefined;
      this.generatedIndex += 1;
      if (this.observedQueue.length) this.insertedObserved += 1;
      this.generatedStartedAt ||= this.elapsed;
      const generatedCount = this.current.contextTokens.filter((token) => token.origin === 'generated').length;
      const seconds = Math.max(0.25, (this.elapsed - this.generatedStartedAt) / 1000);
      this.current.tokensPerSecond = generatedCount / seconds;
      this.cycleElapsed = 0;
    }

    this.updateInfluence();
    this.current.attentionEdges = strongestEdges(this.current.contextTokens, this.elapsed);
    return this.state();
  }

  ingestObservedOutput(output: string) {
    const cleaned = output.trim();
    if (!cleaned || cleaned === this.outputSnapshot || /^(Thinking…|Searching external context…|.+ mode · .+…)$/.test(cleaned)) return;
    this.outputSnapshot = cleaned;
    this.observedQueue = tokenizeVisible(cleaned).slice(0, 120);
  }

  ingestToolEvent(event: { kind: 'tool-request' | 'tool-observation'; name: string; detail?: string; ok?: boolean }) {
    this.current.phase = 'tool';
    this.current.attentionEdges = [];
    this.current.candidates = [];
    this.current.generatedToken = undefined;
    this.current.toolEvent = {
      stage: event.kind === 'tool-request' ? 'request' : 'observation',
      name: event.name,
      detail: event.detail || (event.ok === false ? 'tool failed' : 'returned observation'),
    };
    this.liveToolHold = event.kind === 'tool-request' ? -1 : 900;
  }

  setPaused(paused: boolean) {
    this.current.paused = paused;
  }

  triggerToolDemo() {
    if (this.toolElapsed !== null) return;
    this.toolElapsed = 0;
    this.current.phase = 'tool';
    this.current.candidates = [];
    this.current.generatedToken = undefined;
    this.current.attentionEdges = [];
    this.current.toolEvent = { stage: 'request', name: 'site_context', detail: 'ocean exposure', simulated: true };
  }

  reset() {
    this.elapsed = 0;
    this.cycleElapsed = 0;
    this.generatedIndex = 0;
    this.generatedStartedAt = 0;
    this.insertedObserved = 0;
    this.toolElapsed = null;
    this.liveToolHold = null;
    this.current = this.initialState();
  }

  private initialState(): InferenceState {
    const pieces = tokenizeVisible(this.prompt);
    const raw = pieces.map((text, index) => ({ id: `prompt-${index}-${hashId(text)}`, text }));
    const embeddings = raw.map(() => undefined as number[] | undefined);
    const pca = embeddings.every(Boolean) ? projectEmbeddingsWithPca(embeddings as number[][]) : null;
    const points = pca || projectMockSemantics(raw);
    const tokens: TokenVisual[] = raw.map((token, index) => ({
      ...token,
      projectedX: points[index].x,
      projectedY: points[index].y,
      influence: 0.18,
      origin: 'prompt',
    }));
    return {
      phase: 'reading',
      contextTokens: selectVisibleTokens(tokens),
      activeTokenIds: [],
      attentionEdges: [],
      candidates: [],
      provenance: {
        tokenization: 'derived',
        projection: pca ? 'derived' : 'simulated',
        influence: 'simulated',
        attention: 'simulated',
        candidates: 'simulated',
      },
    };
  }

  private nextGeneratedText() {
    if (this.observedQueue.length) return this.observedQueue[this.insertedObserved];
    return DEMO_SEQUENCE[this.generatedIndex];
  }

  private makeGeneratedToken(text: string): TokenVisual {
    const id = `generated-${this.generatedIndex}-${hashId(text)}`;
    const [semanticPoint] = projectMockSemantics([{ id, text }]);
    const point = openPoint(semanticPoint, id, this.current.contextTokens);
    return {
      id,
      text,
      projectedX: point.x,
      projectedY: point.y,
      influence: 1,
      origin: 'generated',
    };
  }

  private updateInfluence() {
    const next = this.nextGeneratedText() || '';
    this.current.contextTokens = this.current.contextTokens.map((token, index) => {
      const semantic = semanticAffinity(token.text, next);
      const pulse = 0.5 + 0.5 * Math.sin(this.elapsed / 430 + stableUnit(token.id, 91) * Math.PI * 2);
      return { ...token, influence: Math.min(1, 0.12 + semantic * 0.56 + pulse * 0.25 + (index % 3) * 0.025) };
    });
    this.current.activeTokenIds = [...this.current.contextTokens]
      .sort((a, b) => (b.influence || 0) - (a.influence || 0))
      .slice(0, 5)
      .map((token) => token.id);
  }

  private advanceTool() {
    const elapsed = this.toolElapsed || 0;
    this.current.phase = 'tool';
    if (elapsed < 720) {
      this.current.toolEvent = { stage: 'request', name: 'site_context', detail: 'ocean exposure', simulated: true };
      return;
    }
    if (elapsed < 1_520) {
      this.current.toolEvent = { stage: 'executing', name: 'site_context', detail: 'separate system event', simulated: true };
      return;
    }
    if (elapsed < 2_260) {
      this.current.toolEvent = { stage: 'observation', name: 'site_context', detail: 'salt air · prevailing wind', simulated: true };
      return;
    }
    this.returnToolObservation('salt air prevailing wind');
    this.toolElapsed = null;
    this.cycleElapsed = 0;
  }

  private returnToolObservation(detail: string) {
    const visible = tokenizeVisible(detail).slice(0, 3).join('-') || 'observation';
    const id = `observation-${hashId(visible)}`;
    if (!this.current.contextTokens.some((token) => token.id === id)) {
      this.current.contextTokens = selectVisibleTokens([...this.current.contextTokens, {
        id,
        text: visible,
        projectedX: 0.76,
        projectedY: 0.63,
        influence: 0.72,
        origin: 'observation',
      }], this.current.activeTokenIds);
    }
    this.current.toolEvent = undefined;
    this.current.phase = 'computing';
  }
}

function openPoint(point: { x: number; y: number }, id: string, tokens: TokenVisual[]) {
  const candidates = [{ x: point.x, y: point.y }];
  for (let ring = 1; ring <= 3; ring += 1) {
    const radius = ring * 0.075;
    for (let step = 0; step < 10; step += 1) {
      const angle = stableUnit(id, 151) * Math.PI * 2 + (step / 10) * Math.PI * 2;
      candidates.push({
        x: Math.max(0.1, Math.min(0.86, point.x + Math.cos(angle) * radius)),
        y: Math.max(0.1, Math.min(0.86, point.y + Math.sin(angle) * radius)),
      });
    }
  }
  return candidates.reduce((best, candidate) => {
    const clearance = Math.min(...tokens.map((token) => Math.hypot((candidate.x - token.projectedX) * 0.8, candidate.y - token.projectedY)));
    const bestClearance = Math.min(...tokens.map((token) => Math.hypot((best.x - token.projectedX) * 0.8, best.y - token.projectedY)));
    return clearance > bestClearance ? candidate : best;
  }, candidates[0]);
}

function candidatesFor(selected: string): TokenCandidate[] {
  const known = CANDIDATES[selected.toLocaleLowerCase()];
  if (known) return known;
  const alternatives = ['the', 'and', 'with', 'through'];
  const unique = [selected, ...alternatives.filter((item) => item !== selected)].slice(0, 4);
  const weights = [0.46, 0.22, 0.13, 0.07];
  return unique.map((text, index) => ({ text, probability: weights[index] }));
}

function strongestEdges(tokens: TokenVisual[], elapsed: number): AttentionEdge[] {
  const edges: AttentionEdge[] = [];
  for (let source = 0; source < tokens.length; source += 1) {
    for (let target = source + 1; target < tokens.length; target += 1) {
      const a = tokens[source];
      const b = tokens[target];
      const distance = Math.hypot(a.projectedX - b.projectedX, a.projectedY - b.projectedY);
      const semantic = semanticAffinity(a.text, b.text);
      const modulation = 0.88 + Math.sin(elapsed / 520 + source * 0.7 + target) * 0.12;
      edges.push({ sourceTokenId: a.id, targetTokenId: b.id, weight: Math.max(0, (1 - distance) * 0.58 + semantic * 0.42) * modulation });
    }
  }
  return edges.sort((a, b) => b.weight - a.weight).slice(0, 4);
}

function semanticAffinity(left: string, right: string) {
  const a = left.toLocaleLowerCase();
  const b = right.toLocaleLowerCase();
  const pairs = [
    ['design', 'house'], ['concrete', 'house'], ['house', 'ocean'], ['beside', 'ocean'],
    ['broad', 'openings'], ['openings', 'ocean'], ['sheltered', 'courtyard'], ['small', 'house'],
  ];
  if (pairs.some(([x, y]) => (a === x && b === y) || (a === y && b === x))) return 1;
  if (a === b) return 0.9;
  if (a[0] && a[0] === b[0]) return 0.35;
  return 0.12 + stableUnit(`${a}:${b}`, 113) * 0.18;
}

function hashId(text: string) {
  return Math.floor(stableUnit(text, 137) * 1_000_000).toString(36);
}

function cloneState(state: InferenceState): InferenceState {
  return {
    ...state,
    contextTokens: state.contextTokens.map((token) => ({ ...token })),
    activeTokenIds: [...state.activeTokenIds],
    attentionEdges: state.attentionEdges.map((edge) => ({ ...edge })),
    candidates: state.candidates.map((candidate) => ({ ...candidate })),
    generatedToken: state.generatedToken ? { ...state.generatedToken } : undefined,
    toolEvent: state.toolEvent ? { ...state.toolEvent } : undefined,
    provenance: { ...state.provenance },
  };
}
