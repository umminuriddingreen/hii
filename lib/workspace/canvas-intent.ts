import { workspaceNodeTitle } from './search';
import type { WorkspaceNode } from './types';

export type CanvasIntent =
  | { kind: 'delete' | 'duplicate' | 'tidy'; targetIds: string[] }
  | { kind: 'move'; targetIds: string[]; dx: number; dy: number }
  | { kind: 'fit-all' }
  | { kind: 'focus'; nodeId: string }
  | { kind: 'clarify'; message: string };

export type CanvasIntentContext = {
  nodes: WorkspaceNode[];
  selectedIds: string[];
  visibleIds: string[];
  moveStep?: number;
};

const words = (value: string) => value.toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim();

function contextualTargets(input: string, context: CanvasIntentContext) {
  if (/\b(on (the )?screen|in (the )?(view|viewport)|visible)\b/.test(input)) return context.visibleIds;
  return context.selectedIds.length ? context.selectedIds : context.visibleIds;
}

/** Interpret only unambiguous, local canvas operations. Unknown text remains an agent intent. */
export function interpretCanvasIntent(value: string, context: CanvasIntentContext): CanvasIntent | null {
  const input = words(value);
  if (!input) return null;

  if (/^(fit|show|view) (all|everything|the (whole )?(board|canvas|workspace))$/.test(input) || /^(zoom|take me) (to|out to) (all|everything|my work)$/.test(input)) {
    return { kind: 'fit-all' };
  }

  const focus = input.match(/^(?:focus(?: on)?|open|show me|take me to)\s+(.+)$/);
  if (focus) {
    const wanted = focus[1].replace(/^(?:the|node)\s+/, '').replace(/\s+node$/, '').trim();
    const visible = new Set(context.visibleIds);
    const ranked = context.nodes
      .map((node) => ({ node, title: words(workspaceNodeTitle(node)) }))
      .filter(({ title }) => title === wanted || title.includes(wanted))
      .sort((a, b) => Number(visible.has(b.node.id)) - Number(visible.has(a.node.id)) || a.title.length - b.title.length);
    if (ranked[0]) return { kind: 'focus', nodeId: ranked[0].node.id };
  }

  const targets = contextualTargets(input, context);
  if (/^(?:clear|delete|remove)(?: (?:this|these|it|them|the selection|selected(?: nodes?| objects?)?|visible(?: nodes?| objects?)?|everything (?:visible|on (?:the )?screen)))$/.test(input)) {
    if (!context.selectedIds.length && !/\b(visible|on (?:the )?screen)\b/.test(input)) {
      return { kind: 'clarify', message: 'Select what to delete, or say “delete everything visible”.' };
    }
    return targets.length ? { kind: 'delete', targetIds: targets } : { kind: 'clarify', message: 'Nothing matching that request is visible.' };
  }
  if (/^(?:duplicate|copy)(?: (?:this|these|it|them|the selection|selected(?: nodes?| objects?)?|visible(?: nodes?| objects?)?))$/.test(input)) {
    return targets.length ? { kind: 'duplicate', targetIds: targets } : null;
  }
  if (/^(?:tidy|organize|arrange)(?: (?:this|these|them|the selection|selected(?: nodes?| objects?)?|visible(?: nodes?| objects?)?|the (?:board|canvas|workspace)|everything(?: visible)?))?$/.test(input)) {
    const tidyTargets = targets.length ? targets : context.visibleIds;
    return tidyTargets.length ? { kind: 'tidy', targetIds: tidyTargets } : null;
  }

  const move = input.match(/^(?:move|nudge|shift)(?: (?:this|these|it|them|the selection|selected(?: nodes?| objects?)?))?\s+(left|right|up|down)$/);
  if (move && targets.length) {
    const step = context.moveStep ?? 40;
    const [dx, dy] = move[1] === 'left' ? [-step, 0] : move[1] === 'right' ? [step, 0] : move[1] === 'up' ? [0, -step] : [0, step];
    return { kind: 'move', targetIds: targets, dx, dy };
  }
  return null;
}
