export type InferencePhase =
  | 'reading'
  | 'computing'
  | 'generating'
  | 'tool'
  | 'idle';

export type InferenceProvenance = 'observed' | 'derived' | 'simulated';

export interface TokenVisual {
  id: string;
  text: string;
  tokenId?: number;
  embedding?: number[];
  projectedX: number;
  projectedY: number;
  influence?: number;
  origin?: 'prompt' | 'generated' | 'observation';
}

export interface AttentionEdge {
  sourceTokenId: string;
  targetTokenId: string;
  weight: number;
}

export interface TokenCandidate {
  text: string;
  tokenId?: number;
  probability: number;
}

export interface ToolVisualEvent {
  stage: 'request' | 'executing' | 'observation';
  name: string;
  detail: string;
  simulated?: boolean;
}

export interface InferenceState {
  phase: InferencePhase;
  contextTokens: TokenVisual[];
  activeTokenIds: string[];
  attentionEdges: AttentionEdge[];
  candidates: TokenCandidate[];
  generatedToken?: TokenVisual;
  tokensPerSecond?: number;
  toolEvent?: ToolVisualEvent;
  paused?: boolean;
  provenance: {
    tokenization: InferenceProvenance;
    projection: InferenceProvenance;
    influence: InferenceProvenance;
    attention: InferenceProvenance;
    candidates: InferenceProvenance;
  };
}

export interface InferenceRuntimeAdapter {
  state(): InferenceState;
  advance(deltaMs: number): InferenceState;
  ingestObservedOutput(output: string): void;
  ingestToolEvent(event: { kind: 'tool-request' | 'tool-observation'; name: string; detail?: string; ok?: boolean }): void;
  setPaused(paused: boolean): void;
  triggerToolDemo(): void;
  reset(): void;
}
