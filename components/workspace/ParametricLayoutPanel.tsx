'use client';

import { useState } from 'react';
import type { ParametricLayoutKind } from '@/lib/workspace/parametric-layout';

export type ParametricLayoutSettings = {
  layout: ParametricLayoutKind;
  scale: number;
  spacing: number;
};

export function ParametricLayoutPanel({ count, onApply, onClose }: {
  count: number;
  onApply: (settings: ParametricLayoutSettings) => void;
  onClose: () => void;
}) {
  const [layout, setLayout] = useState<ParametricLayoutKind>('field');
  const [scale, setScale] = useState(1);
  const [spacing, setSpacing] = useState(48);
  return <aside className="hii-parametric-panel" data-workspace-ui aria-label="Parametric image layout" onPointerDown={(event) => event.stopPropagation()}>
    <header><div><small>projection instrument</small><strong>Arrange images</strong></div><button type="button" aria-label="Close parametric layout" onClick={onClose}>×</button></header>
    <p>{count ? `${count} image object${count === 1 ? '' : 's'}` : 'No image objects on this canvas'}</p>
    <fieldset>
      <legend>layout</legend>
      {(['field', 'grid', 'chronology', 'constellation'] as const).map((value) => <button key={value} type="button" aria-pressed={layout === value} onClick={() => setLayout(value)}>{value}</button>)}
    </fieldset>
    <label><span>scale <output>{scale.toFixed(2)}</output></span><input type="range" min="0.5" max="1.6" step="0.05" value={scale} onChange={(event) => setScale(Number(event.target.value))} /></label>
    <label><span>spacing <output>{spacing}</output></span><input type="range" min="12" max="180" step="4" value={spacing} onChange={(event) => setSpacing(Number(event.target.value))} /></label>
    <button className="hii-parametric-apply" type="button" disabled={!count} onClick={() => onApply({ layout, scale, spacing })}>apply to canvas</button>
    <small>Selection scopes the operation. With no image selected, every image is arranged.</small>
  </aside>;
}
