'use client';

import { type CSSProperties, type ReactNode } from 'react';
import { ArrowsOutLineHorizontal, Export, LinkSimple, SlidersHorizontal } from '@phosphor-icons/react';
import styles from './CanvasSelectionBar.module.css';

export type CanvasSelectionAction = 'format' | 'connect' | 'inspect' | 'export';

export type CanvasSelectionBarProps = {
  selectionCount: number;
  selectionType?: string;
  foreground?: string;
  fontSize?: number;
  canConnect?: boolean;
  anchor?: { x: number; y: number };
  onAction: (action: CanvasSelectionAction) => void;
};

const actions: Array<{ id: CanvasSelectionAction; label: string; icon: (props: { size?: number; 'aria-hidden'?: boolean }) => ReactNode }> = [
  { id: 'format', label: 'Format', icon: SlidersHorizontal },
  { id: 'connect', label: 'Connect', icon: LinkSimple },
  { id: 'inspect', label: 'Inspect', icon: ArrowsOutLineHorizontal },
  { id: 'export', label: 'Export', icon: Export }
];

export function CanvasSelectionBar({ selectionCount, selectionType, foreground = '#111111', fontSize = 18, canConnect = true, anchor, onAction }: CanvasSelectionBarProps) {
  if (selectionCount < 1) return null;
  const style = anchor ? ({ '--selection-x': `${anchor.x}px`, '--selection-y': `${anchor.y}px` } as CSSProperties) : undefined;
  return <aside className={styles.bar} data-follow-selection={Boolean(anchor) || undefined} style={style} data-workspace-ui aria-label={`${selectionCount} canvas object${selectionCount === 1 ? '' : 's'} selected`} onPointerDown={(event) => event.stopPropagation()}>
    {selectionCount > 1 ? <><span className={styles.count} aria-hidden="true">{selectionCount}</span><span className={styles.label}>objects</span><span className={styles.divider} aria-hidden="true" /></> : null}
    {selectionCount === 1 && selectionType === 'canvas-text' ? <>
      <button type="button" className={styles.swatchButton} aria-label="Text color" title="Text color" onClick={() => onAction('format')}><i style={{ background: foreground }} /></button>
      <button type="button" className={styles.textButton} aria-label="Text formatting" title="Text formatting" onClick={() => onAction('format')}>Aa</button>
      <button type="button" className={styles.sizeButton} aria-label={`Font size ${fontSize}`} title="Font size" onClick={() => onAction('format')}>{fontSize}</button>
      <span className={styles.divider} aria-hidden="true" />
    </> : null}
    {actions.filter(({ id }) => !(selectionCount === 1 && selectionType === 'canvas-text' && id === 'format')).map(({ id, label, icon: Icon }) => <button
      key={id}
      type="button"
      disabled={id === 'connect' && !canConnect}
      onClick={() => onAction(id)}
    >
      <Icon size={16} aria-hidden={true} />
      <span>{label}</span>
    </button>)}
  </aside>;
}
