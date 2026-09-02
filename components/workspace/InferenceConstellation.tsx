'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createInferenceRuntime } from '@/lib/inference/runtime';
import type { InferenceState, TokenVisual } from '@/lib/inference/types';
import type { AgentEventV1 } from '@/lib/client/hii-bridge';
import styles from './InferenceConstellation.module.css';

type Props = {
  prompt: string;
  observedOutput?: string;
  agentEvent?: AgentEventV1;
};

type Size = { width: number; height: number };

export function InferenceConstellation({ prompt, observedOutput = '', agentEvent }: Props) {
  const runtime = useMemo(() => createInferenceRuntime(prompt), [prompt]);
  const [state, setState] = useState<InferenceState>(() => runtime.state());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [technical, setTechnical] = useState(false);
  const [size, setSize] = useState<Size>({ width: 900, height: 520 });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef(new Map<string, { x: number; y: number }>());
  const stateRef = useRef(state);

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { runtime.ingestObservedOutput(observedOutput); }, [observedOutput, runtime]);
  useEffect(() => {
    if (agentEvent?.activity) runtime.ingestToolEvent(agentEvent.activity);
  }, [agentEvent, runtime]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const resize = () => setSize({ width: root.clientWidth, height: root.clientHeight });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let frame = 0;
    let previous = performance.now();
    let lastReactUpdate = 0;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const tick = (now: number) => {
      const delta = Math.min(100, now - previous);
      previous = now;
      const next = runtime.advance(reduced ? Math.min(delta, 40) : delta);
      stateRef.current = next;
      drawScene(canvasRef.current, next, sceneRef.current, size, reduced ? 1 : delta / 16.67);
      if (now - lastReactUpdate > 58) {
        setState(next);
        lastReactUpdate = now;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [runtime, size]);

  const inspected = tokenById(state, selectedId || hoveredId);
  const generated = state.contextTokens.filter((token) => token.origin === 'generated').map((token) => token.text).join(' ');
  const neighbors = inspected ? nearestTokens(inspected, state.contextTokens).map((token) => token.text).join(' · ') : '';
  const relations = inspected
    ? state.attentionEdges
      .filter((edge) => edge.sourceTokenId === inspected.id || edge.targetTokenId === inspected.id)
      .slice(0, 3)
      .map((edge) => `${tokenById(state, edge.sourceTokenId === inspected.id ? edge.targetTokenId : edge.sourceTokenId)?.text || 'token'} ${edge.weight.toFixed(2)}`)
      .join(' · ')
    : '';

  return (
    <section ref={rootRef} className={styles.instrument} data-phase={state.phase} aria-label="Inference token constellation">
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
      <header className={styles.header}>
        <span className={styles.phase}>{state.paused ? 'Paused' : state.phase}</span>
        <span className={styles.rate}>{state.tokensPerSecond ? `~${state.tokensPerSecond.toFixed(1)} tok/s` : ''}</span>
      </header>
      <div className={styles.controls}>
        <button type="button" aria-label={state.paused ? 'Play inference animation' : 'Pause inference animation'} onClick={() => { runtime.setPaused(!state.paused); setState(runtime.state()); }}>
          {state.paused ? '▶' : 'Ⅱ'}
        </button>
        <button type="button" aria-label="Toggle technical inference view" aria-pressed={technical} onClick={() => setTechnical((value) => !value)}>T</button>
      </div>

      <div className={styles.labels}>
        {state.contextTokens.map((token) => (
          <button
            type="button"
            className={styles.token}
            key={token.id}
            data-origin={token.origin}
            data-selected={selectedId === token.id || undefined}
            style={{
              left: `${token.projectedX * 100}%`,
              top: `${token.projectedY * 100}%`,
              opacity: 0.28 + (token.influence || 0) * 0.72,
              transform: `translate(-50%, -50%) scale(${1 + (token.influence || 0) * 0.025})`,
            }}
            onPointerEnter={() => setHoveredId(token.id)}
            onPointerLeave={() => setHoveredId(null)}
            onClick={() => setSelectedId((id) => id === token.id ? null : token.id)}
          >
            {token.text}
          </button>
        ))}
      </div>

      {state.phase === 'generating' && state.candidates.length > 0 && (
        <div className={styles.generationZone} aria-label="Next token candidates">
          {state.candidates.slice(0, 5).map((candidate) => (
            <span className={styles.candidate} key={candidate.text}>
              <span>{candidate.text}</span>
              <code>{candidate.probability.toFixed(2)}</code>
            </span>
          ))}
        </div>
      )}

      {state.toolEvent && (
        <div className={styles.toolRail} role="status">
          <small>{state.toolEvent.stage} · outside model</small>
          <strong>{state.toolEvent.name}</strong>
          <span>{state.toolEvent.detail}</span>
        </div>
      )}

      <div className={styles.generated}>
        <span className={styles.generatedLabel}>Generated</span>
        <span className={styles.generatedText}>{generated || state.generatedToken?.text || '—'}</span>
      </div>

      {inspected && (
        <aside className={styles.inspector} aria-label={`Inspect token ${inspected.text}`}>
          <small>Token inspection</small>
          <strong>{JSON.stringify(inspected.text)}</strong>
          <dl>
            <div><dt>token ID</dt><dd>{inspected.tokenId ?? 'not supplied'}</dd></div>
            <div><dt>influence</dt><dd>{(inspected.influence || 0).toFixed(3)}</dd></div>
            <div><dt>neighbors</dt><dd>{neighbors || '—'}</dd></div>
            <div><dt>attention</dt><dd>{relations || '—'}</dd></div>
          </dl>
        </aside>
      )}

      {technical && (
        <aside className={styles.technical} aria-label="Technical inference details">
          <div><span>context</span><code>{state.contextTokens.length} tokens</code></div>
          <div><span>prompt / generated</span><code>{state.contextTokens.filter((token) => token.origin === 'prompt').length} / {state.contextTokens.filter((token) => token.origin === 'generated').length}</code></div>
          <div><span>projection</span><code>{state.provenance.projection}</code></div>
          <div><span>attention</span><code>{state.provenance.attention} · {state.attentionEdges.length} edges</code></div>
          <div><span>candidates</span><code>{state.provenance.candidates}</code></div>
          <div><span>selected xy</span><code>{inspected ? `${inspected.projectedX.toFixed(3)}, ${inspected.projectedY.toFixed(3)}` : '—'}</code></div>
          <button type="button" onClick={() => { runtime.triggerToolDemo(); setState(runtime.state()); }}>Run simulated tool event</button>
        </aside>
      )}
    </section>
  );
}

function tokenById(state: InferenceState, id: string | null | undefined) {
  return id ? state.contextTokens.find((token) => token.id === id) : undefined;
}

function nearestTokens(token: TokenVisual, tokens: TokenVisual[]) {
  return tokens
    .filter((candidate) => candidate.id !== token.id)
    .sort((left, right) => distance(token, left) - distance(token, right))
    .slice(0, 4);
}

function distance(left: TokenVisual, right: TokenVisual) {
  return Math.hypot(left.projectedX - right.projectedX, left.projectedY - right.projectedY);
}

function drawScene(
  canvas: HTMLCanvasElement | null,
  state: InferenceState,
  positions: Map<string, { x: number; y: number }>,
  size: Size,
  motionScale: number,
) {
  if (!canvas || size.width < 1 || size.height < 1) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(size.width * ratio);
  const height = Math.round(size.height * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, size.width, size.height);

  const field = { x: 22, y: 56, width: Math.max(200, size.width - 154), height: Math.max(220, size.height - 134) };
  const soften = state.phase === 'tool' ? 0.26 : 1;
  const interpolation = motionScale === 1 ? 1 : Math.min(0.18, 0.075 * motionScale);
  for (const token of state.contextTokens) {
    const target = { x: field.x + token.projectedX * field.width, y: field.y + token.projectedY * field.height };
    const prior = positions.get(token.id) || target;
    const current = {
      x: prior.x + (target.x - prior.x) * interpolation,
      y: prior.y + (target.y - prior.y) * interpolation,
    };
    positions.set(token.id, current);
  }

  context.save();
  context.globalAlpha = soften;
  for (const edge of state.attentionEdges.slice(0, 5)) {
    const source = positions.get(edge.sourceTokenId);
    const target = positions.get(edge.targetTokenId);
    if (!source || !target) continue;
    context.beginPath();
    context.moveTo(source.x, source.y);
    const bend = (source.x + target.x) / 2;
    context.bezierCurveTo(bend, source.y, bend, target.y, target.x, target.y);
    context.strokeStyle = `rgba(73, 109, 134, ${0.08 + edge.weight * 0.31})`;
    context.lineWidth = 0.55 + edge.weight * 0.7;
    context.stroke();
  }

  for (const token of state.contextTokens) {
    const point = positions.get(token.id);
    if (!point) continue;
    const influence = token.influence || 0;
    context.beginPath();
    context.arc(point.x, point.y, 2.1 + influence * 2.2, 0, Math.PI * 2);
    context.fillStyle = token.origin === 'prompt'
      ? `rgba(17, 22, 26, ${0.18 + influence * 0.58})`
      : `rgba(73, 109, 134, ${0.42 + influence * 0.48})`;
    context.fill();
    if (influence > 0.72) {
      context.beginPath();
      context.arc(point.x, point.y, 7 + influence * 5, 0, Math.PI * 2);
      context.strokeStyle = `rgba(73, 109, 134, ${(influence - 0.7) * 0.22})`;
      context.lineWidth = 0.6;
      context.stroke();
    }
  }
  context.restore();

  const apertureX = size.width - 111;
  context.beginPath();
  context.moveTo(apertureX, size.height * 0.34);
  context.lineTo(apertureX, size.height * 0.66);
  context.strokeStyle = 'rgba(73, 109, 134, .18)';
  context.lineWidth = 1;
  context.stroke();
  if (state.generatedToken) {
    const target = positions.get(state.generatedToken.id) || {
      x: field.x + state.generatedToken.projectedX * field.width,
      y: field.y + state.generatedToken.projectedY * field.height,
    };
    context.beginPath();
    context.moveTo(apertureX, size.height / 2);
    context.lineTo(target.x, target.y);
    context.strokeStyle = 'rgba(73, 109, 134, .5)';
    context.lineWidth = 1;
    context.stroke();
    context.beginPath();
    context.arc(apertureX - 9, size.height / 2, 4.5, 0, Math.PI * 2);
    context.fillStyle = '#496d86';
    context.fill();
  }
}
