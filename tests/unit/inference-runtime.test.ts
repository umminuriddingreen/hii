import { describe, expect, it } from 'vitest';
import { projectEmbeddingsWithPca, projectMockSemantics } from '@/lib/inference/projection';
import { createInferenceRuntime, selectVisibleTokens, tokenizeVisible } from '@/lib/inference/runtime';
import type { TokenVisual } from '@/lib/inference/types';

describe('inference visualization runtime', () => {
  it('turns the supplied prompt into stable visible tokens', () => {
    const prompt = 'Design a small concrete house beside the ocean.';
    expect(tokenizeVisible(prompt)).toEqual(['Design', 'a', 'small', 'concrete', 'house', 'beside', 'the', 'ocean', '.']);
    expect(projectMockSemantics([{ id: 'house', text: 'house' }])).toEqual(projectMockSemantics([{ id: 'house', text: 'house' }]));
  });

  it('keeps mocked projection separate from PCA projection', () => {
    const projected = projectEmbeddingsWithPca([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [0.7, 0.2, 0.1],
    ]);
    expect(projected).toHaveLength(4);
    expect(projected?.every((point) => point.x >= 0.119 && point.x <= 0.801 && point.y >= 0.159 && point.y <= 0.841)).toBe(true);
    expect(projectEmbeddingsWithPca([[1, 2]])).toBeNull();
  });

  it('runs reading, influence, candidate resolution, and reinsertion', () => {
    const runtime = createInferenceRuntime('Design a small concrete house beside the ocean.');
    advance(runtime, 800);
    expect(runtime.state().phase).toBe('computing');
    expect(runtime.state().attentionEdges.length).toBeLessThanOrEqual(4);
    advance(runtime, 800);
    advance(runtime, 500);
    expect(runtime.state().phase).toBe('generating');
    expect(runtime.state().candidates[0]).toEqual({ text: 'with', probability: 0.42 });
    advance(runtime, 750);
    expect(runtime.state().contextTokens.some((token) => token.origin === 'generated')).toBe(true);
  });

  it('pauses without advancing and keeps tools outside the model phase', () => {
    const runtime = createInferenceRuntime();
    runtime.setPaused(true);
    const before = runtime.state();
    advance(runtime, 2_000);
    expect(runtime.state().phase).toBe(before.phase);
    runtime.setPaused(false);
    runtime.triggerToolDemo();
    expect(runtime.state().phase).toBe('tool');
    expect(runtime.state().toolEvent?.stage).toBe('request');
    advance(runtime, 900);
    expect(runtime.state().toolEvent?.stage).toBe('executing');
    advance(runtime, 800);
    expect(runtime.state().toolEvent?.stage).toBe('observation');
    advance(runtime, 800);
    expect(runtime.state().phase).toBe('computing');
    expect(runtime.state().contextTokens.some((token) => token.origin === 'observation')).toBe(true);
  });

  it('projects structured live tool events onto a separate rail', () => {
    const runtime = createInferenceRuntime();
    runtime.ingestToolEvent({ kind: 'tool-request', name: 'web_fetch', detail: 'https://example.com' });
    expect(runtime.state().phase).toBe('tool');
    expect(runtime.state().attentionEdges).toEqual([]);
    runtime.ingestToolEvent({ kind: 'tool-observation', name: 'web_fetch', detail: 'ocean wind data', ok: true });
    expect(runtime.state().toolEvent?.stage).toBe('observation');
    advance(runtime, 1_000);
    expect(runtime.state().phase).toBe('computing');
    expect(runtime.state().contextTokens.some((token) => token.origin === 'observation')).toBe(true);
  });

  it('hard caps large contexts while retaining selected and recent tokens', () => {
    const tokens: TokenVisual[] = Array.from({ length: 260 }, (_, index) => ({
      id: `token-${index}`,
      text: String(index),
      projectedX: 0.5,
      projectedY: 0.5,
      influence: index / 260,
    }));
    const visible = selectVisibleTokens(tokens, ['token-3']);
    expect(visible).toHaveLength(200);
    expect(visible.some((token) => token.id === 'token-3')).toBe(true);
    expect(visible.some((token) => token.id === 'token-259')).toBe(true);
  });
});

function advance(runtime: ReturnType<typeof createInferenceRuntime>, milliseconds: number) {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 100) runtime.advance(Math.min(100, milliseconds - elapsed));
}
