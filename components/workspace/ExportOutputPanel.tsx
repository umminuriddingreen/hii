'use client';

import type { WorkspaceNode } from '@/lib/workspace/types';

function safeName(node: WorkspaceNode) {
  const raw = String(node.payload.name || node.payload.title || node.type || 'hii-output');
  return raw.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'hii-output';
}

export function downloadWorkspaceOutput(node: WorkspaceNode) {
  const text = node.type === 'note' ? String(node.payload.content || '')
    : node.type === 'canvas-text' || node.type === 'text' ? String(node.payload.text || node.payload.content || '')
      : JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), node }, null, 2);
  const plain = node.type === 'note' || node.type === 'canvas-text' || node.type === 'text';
  const blob = new Blob([text], { type: plain ? 'text/plain;charset=utf-8' : 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safeName(node)}.${plain ? 'txt' : 'hii.json'}`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExportOutputPanel({ node, onCanvas, onDownload, onClose }: {
  node: WorkspaceNode;
  onCanvas: () => void;
  onDownload: () => void;
  onClose: () => void;
}) {
  return <aside className="hii-export-panel" data-workspace-ui aria-label="Export selected output" onPointerDown={(event) => event.stopPropagation()}>
    <header><div><small>selected output</small><strong>{String(node.payload.name || node.payload.title || node.type)}</strong></div><button type="button" aria-label="Close export" onClick={onClose}>×</button></header>
    <button type="button" onClick={onCanvas}>duplicate on canvas</button>
    <button type="button" onClick={onDownload}>save to a folder</button>
    <small>Canvas keeps the object editable. Folder export creates a portable text or HII JSON file.</small>
  </aside>;
}
