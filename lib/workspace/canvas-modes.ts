// SPDX-License-Identifier: LicenseRef-BSL-1.1

export type CanvasModeId = 'build' | 'plan' | 'browse' | 'see' | 'show';

export type CanvasMode = {
  id: CanvasModeId;
  label: string;
  verb: string;
  description: string;
  authority: 'read-only' | 'workspace';
};

export const canvasModes: CanvasMode[] = [
  { id: 'build', label: 'Build', verb: 'make', description: 'Create, test, and keep the artifact', authority: 'workspace' },
  { id: 'plan', label: 'Plan', verb: 'think', description: 'Inspect and propose without changing anything', authority: 'read-only' },
  { id: 'browse', label: 'Browse', verb: 'research', description: 'Search with SearxNG and load source context', authority: 'read-only' },
  { id: 'see', label: 'See', verb: 'observe', description: 'Read the canvas and computer state', authority: 'read-only' },
  { id: 'show', label: 'Present', verb: 'compose', description: 'Make a presentation from selected or workspace material', authority: 'workspace' }
];

export const defaultCanvasMode: CanvasModeId = 'build';

export function canvasMode(id: CanvasModeId) {
  return canvasModes.find((mode) => mode.id === id) || canvasModes[0];
}

export function nextCanvasMode(id: CanvasModeId) {
  const index = canvasModes.findIndex((mode) => mode.id === id);
  return canvasModes[(index + 1) % canvasModes.length].id;
}

export function isCanvasMode(value: unknown): value is CanvasModeId {
  return typeof value === 'string' && canvasModes.some((mode) => mode.id === value);
}

export function canMutateCanvas(id: CanvasModeId) {
  return canvasMode(id).authority === 'workspace';
}

export function presentationRequest(value: string, selectedCount: number) {
  const match = value.trim().match(/^\/presentation(?:\s+(.+))?$/i);
  if (!match) return null;
  return {
    mode: 'show' as const,
    intent: match[1]?.trim() || `Make an editable presentation from ${selectedCount ? 'the selected canvas objects' : 'the current workspace'}.`
  };
}

export function modeIntent(id: CanvasModeId, intent: string) {
  const instruction: Record<CanvasModeId, string> = {
    build: 'BUILD MODE: make the requested workspace-local result, verify the latest change, and return the usable artifact or receipt.',
    plan: 'PLAN MODE: inspect and reason only. Do not write, edit, execute mutating tools, or change the canvas or computer. Return a concrete plan.',
    browse: 'BROWSE MODE: gather broad external context with web_search backed by local SearxNG, then use bounded web_fetch on the strongest sources. Keep source URLs visible. Do not mutate the workspace or computer.',
    see: 'SEE MODE: observe the selected canvas objects and current computer state with read-only capabilities. Describe what is actually present, stale, blocked, or unknown. Change nothing.',
    show: 'PRESENT MODE: create a real presentation artifact from the selected canvas objects, or from the current workspace when nothing is selected. Preserve sources and visual direction, keep the deck editable, place the finished artifact back in the workspace, and verify the exported result.'
  };
  return `${instruction[id]}\n\nHuman intent: ${intent}`;
}
