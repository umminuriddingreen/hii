'use client';

import { type ReactNode } from 'react';
import { ArrowsOutLineHorizontal, LinkSimple, SlidersHorizontal } from '@phosphor-icons/react';
import styles from './CanvasSelectionBar.module.css';

export type CanvasSelectionAction = 'format' | 'connect' | 'inspect';

export type CanvasSelectionBarProps = {
  selectionCount: number;
  canConnect?: boolean;
  onAction: (action: CanvasSelectionAction) => void;
};

const actions: Array<{ id: CanvasSelectionAction; label: string; icon: (props: { size?: number; 'aria-hidden'?: boolean }) => ReactNode }> = [
  { id: 'format', label: 'Format', icon: SlidersHorizontal },
  { id: 'connect', label: 'Connect', icon: LinkSimple },
  { id: 'inspect', label: 'Inspect', icon: ArrowsOutLineHorizontal }
];

export function CanvasSelectionBar({ selectionCount, canConnect = true, onAction }: CanvasSelectionBarProps) {
  if (selectionCount < 1) return null;
  return <aside className={styles.bar} data-workspace-ui aria-label={`${selectionCount} canvas object${selectionCount === 1 ? '' : 's'} selected`} onPointerDown={(event) => event.stopPropagation()}>
    <span className={styles.count} aria-hidden="true">{selectionCount}</span>
    <span className={styles.label}>{selectionCount === 1 ? 'object' : 'objects'}</span>
    <span className={styles.divider} aria-hidden="true" />
    {actions.map(({ id, label, icon: Icon }) => <button
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
