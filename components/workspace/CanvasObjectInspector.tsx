'use client';

import { Lock, LockOpen, X } from '@phosphor-icons/react';
import styles from './CanvasObjectInspector.module.css';

export type CanvasInspectorField = {
  label: string;
  value: string;
  detail?: string;
};

export type CanvasObjectInspectorProps = {
  title: string;
  typeLabel: string;
  selectionCount?: number;
  locked?: boolean;
  fields?: CanvasInspectorField[];
  onLockedChange?: (locked: boolean) => void;
  actions?: Array<{ label: string; onClick: () => void; disabled?: boolean }>;
  onClose: () => void;
};

export function CanvasObjectInspector({ title, typeLabel, selectionCount = 1, locked = false, fields = [], onLockedChange, actions = [], onClose }: CanvasObjectInspectorProps) {
  return <aside className={styles.inspector} data-workspace-ui aria-label="Canvas object inspector" onPointerDown={(event) => event.stopPropagation()}>
    <header>
      <div><small>{selectionCount > 1 ? `${selectionCount} objects` : typeLabel}</small><strong>{title}</strong></div>
      <button type="button" aria-label="Close inspector" onClick={onClose}><X size={16} aria-hidden="true" /></button>
    </header>
    <dl>
      {fields.map((field) => <div key={field.label}>
        <dt>{field.label}</dt><dd>{field.value}{field.detail && <small>{field.detail}</small>}</dd>
      </div>)}
      {!fields.length && <div><dt>Selection</dt><dd>{selectionCount} object{selectionCount === 1 ? '' : 's'}</dd></div>}
    </dl>
    {actions.length > 0 && <div className={styles.actions} role="group" aria-label="Selection arrangement">{actions.map((action) => <button key={action.label} type="button" disabled={action.disabled} onClick={action.onClick}>{action.label}</button>)}</div>}
    {onLockedChange && <button className={styles.lock} type="button" aria-pressed={locked} onClick={() => onLockedChange(!locked)}>
      {locked ? <Lock size={16} aria-hidden="true" /> : <LockOpen size={16} aria-hidden="true" />}
      {locked ? 'Unlock selection' : 'Lock selection'}
    </button>}
  </aside>;
}
