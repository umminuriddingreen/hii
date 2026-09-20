// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { GraphMutationError, type GraphMutationErrorCode } from '../operational-graph/types';
import { workspaceNodeTitle } from './search';
import { normalizeNode, type WorkspaceDoc, type WorkspaceNode } from './types';

/**
 * The stage between a plan and a change.
 *
 * An agent that reports "I updated the facade panels" and an agent that
 * actually did are indistinguishable from their prose. A proposal is the
 * difference: it is computed from real document state before anything is
 * written, so what the user approves is a fact the system produced rather than
 * a claim the model made.
 *
 * This is what makes the receipt downstream of it worth keeping. A receipt that
 * records an assertion launders confabulation into evidence; a receipt that
 * records an approved, system-computed diff records what happened.
 *
 *   INTENT -> PLAN -> PROPOSAL -> PREVIEW -> APPROVAL -> EXECUTION -> RECEIPT
 *                                  ^^^^^^^^^^^^^^^^^^
 *                                   this module
 */

export type ProposedOperation =
  | { op: 'create'; node: WorkspaceNode; reason?: string }
  | { op: 'update'; nodeId: string; patch: Partial<WorkspaceNode>; reason?: string }
  | { op: 'delete'; nodeId: string; reason?: string };

export type ProposalStatus = 'proposed' | 'approved' | 'rejected' | 'applied' | 'stale';

export type WorkspaceProposal = {
  id: string;
  runId?: string;
  intent: string;
  createdAt: string;
  operations: ProposedOperation[];
  /**
   * The Runtime sequence this diff was computed against.
   *
   * Approving a diff computed against state that has since changed is how an
   * agent silently overwrites work someone else did in between. This is the
   * same `expectedSequence` that `runtime_space_apply_v1` checks, so the canvas
   * and the Runtime refuse a stale write on identical grounds rather than on
   * two different notions of "current".
   */
  expectedSequence: number;
  status: ProposalStatus;
};

/** A single line of the preview, resolved against current document state. */
export type OperationPreview = {
  op: ProposedOperation['op'];
  nodeId: string;
  title: string;
  /** Field-level changes for an update, empty for create and delete. */
  changes: { field: string; from: unknown; to: unknown }[];
  /** True when the operation cannot apply cleanly to the current document. */
  conflict?: string;
  reason?: string;
};

export type ProposalPreview = {
  proposalId: string;
  intent: string;
  creates: number;
  updates: number;
  deletes: number;
  conflicts: number;
  /** True when the document moved on since the proposal was computed. */
  stale: boolean;
  operations: OperationPreview[];
  /** One-line summary in the shape a user actually reads. */
  summary: string;
};

const newId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `proposal-${Math.random().toString(36).slice(2)}-${Date.now()}`;

/** Fields whose change is worth showing. Timestamps are noise in a diff. */
const IGNORED_FIELDS = new Set(['updatedAt', 'createdAt', 'z']);

function describe(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number') return Math.round(value * 100) / 100;
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 117)}…` : value;
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') return Object.keys(value as object).join(', ') || '{}';
  return value;
}

function changedFields(before: WorkspaceNode, patch: Partial<WorkspaceNode>) {
  const changes: OperationPreview['changes'] = [];
  for (const [field, next] of Object.entries(patch)) {
    if (IGNORED_FIELDS.has(field)) continue;
    const current = (before as unknown as Record<string, unknown>)[field];
    if (JSON.stringify(current) === JSON.stringify(next)) continue;
    changes.push({ field, from: describe(current), to: describe(next) });
  }
  return changes;
}

export function createProposal(input: {
  intent: string;
  operations: ProposedOperation[];
  doc: WorkspaceDoc;
  runId?: string;
  /**
   * The Runtime snapshot sequence, when the caller has it. The legacy document
   * `revision` mirrors it on the Runtime path (`runtime_space_apply_v1` writes
   * the sequence into the document), so it is the correct fallback and not a
   * second source of truth.
   */
  expectedSequence?: number;
}): WorkspaceProposal {
  return {
    id: newId(),
    runId: input.runId,
    intent: input.intent,
    createdAt: new Date().toISOString(),
    operations: input.operations,
    expectedSequence: input.expectedSequence ?? input.doc.revision,
    status: 'proposed'
  };
}

/**
 * Resolve a proposal against the current document.
 *
 * Conflicts are reported rather than silently dropped, because "3 of your 48
 * panels no longer exist" is the single most useful thing the preview can tell
 * someone before they press Apply.
 */
export function previewProposal(
  proposal: WorkspaceProposal,
  doc: WorkspaceDoc,
  currentSequence?: number
): ProposalPreview {
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const operations: OperationPreview[] = [];
  let creates = 0;
  let updates = 0;
  let deletes = 0;
  let conflicts = 0;

  for (const operation of proposal.operations) {
    if (operation.op === 'create') {
      creates += 1;
      const exists = byId.has(operation.node.id);
      if (exists) conflicts += 1;
      operations.push({
        op: 'create',
        nodeId: operation.node.id,
        title: workspaceNodeTitle(operation.node),
        changes: [],
        conflict: exists ? 'An object with this id already exists.' : undefined,
        reason: operation.reason
      });
      continue;
    }

    const target = byId.get(operation.nodeId);
    if (!target) {
      conflicts += 1;
      if (operation.op === 'delete') deletes += 1;
      else updates += 1;
      operations.push({
        op: operation.op,
        nodeId: operation.nodeId,
        title: operation.nodeId,
        changes: [],
        conflict: 'This object is no longer on the canvas.',
        reason: operation.reason
      });
      continue;
    }

    if (operation.op === 'delete') {
      deletes += 1;
      operations.push({
        op: 'delete',
        nodeId: operation.nodeId,
        title: workspaceNodeTitle(target),
        changes: [],
        reason: operation.reason
      });
      continue;
    }

    updates += 1;
    const changes = changedFields(target, operation.patch);
    operations.push({
      op: 'update',
      nodeId: operation.nodeId,
      title: workspaceNodeTitle(target),
      changes,
      // An update that changes nothing is worth surfacing: it usually means the
      // agent proposed against state it had already applied.
      conflict: changes.length ? undefined : 'This change is already present.',
      reason: operation.reason
    });
    if (!changes.length) conflicts += 1;
  }

  const parts: string[] = [];
  if (creates) parts.push(`+${creates} created`);
  if (updates) parts.push(`~${updates} modified`);
  if (deletes) parts.push(`-${deletes} removed`);

  return {
    proposalId: proposal.id,
    intent: proposal.intent,
    creates,
    updates,
    deletes,
    conflicts,
    stale: (currentSequence ?? doc.revision) !== proposal.expectedSequence,
    operations,
    summary: parts.length ? parts.join(' · ') : 'No changes proposed'
  };
}

export type ApplyResult =
  | { ok: true; doc: WorkspaceDoc; proposal: WorkspaceProposal; applied: number; skipped: OperationPreview[] }
  | { ok: false; error: string; code: GraphMutationErrorCode; preview: ProposalPreview };

/**
 * The refusal, in the Runtime's own vocabulary.
 *
 * A caller that writes through the graph rethrows this so a stale canvas
 * proposal and a stale `runtime_space_apply_v1` fail identically downstream.
 */
export function staleVersionError(proposal: WorkspaceProposal, preview: ProposalPreview) {
  return new GraphMutationError(
    'stale-version',
    'The canvas changed after this was proposed. Re-run the preview before applying.',
    { proposalId: proposal.id, expectedSequence: proposal.expectedSequence, conflicts: preview.conflicts }
  );
}

/**
 * Apply an approved proposal.
 *
 * Conflicting operations are skipped, never forced. A proposal is a description
 * of a change to state the user saw; applying its non-conflicting remainder is
 * honest, while applying its conflicting parts against different state is not
 * the change anyone approved.
 */
export function applyProposal(
  proposal: WorkspaceProposal,
  doc: WorkspaceDoc,
  options: { allowStale?: boolean; currentSequence?: number } = {}
): ApplyResult {
  const preview = previewProposal(proposal, doc, options.currentSequence);

  if (proposal.status === 'applied') {
    return { ok: false, error: 'This proposal was already applied.', code: 'idempotency-conflict', preview };
  }
  if (proposal.status === 'rejected') {
    return { ok: false, error: 'This proposal was rejected.', code: 'invalid-operation', preview };
  }
  if (preview.stale && !options.allowStale) {
    return { ok: false, error: staleVersionError(proposal, preview).message, code: 'stale-version', preview };
  }

  const skipped = preview.operations.filter((operation) => operation.conflict);
  const blocked = new Set(skipped.map((operation) => operation.nodeId));
  const updatedAt = new Date().toISOString();

  let nodes = [...doc.nodes];
  let applied = 0;

  for (const operation of proposal.operations) {
    if (operation.op === 'create') {
      if (blocked.has(operation.node.id)) continue;
      const node = normalizeNode({ ...operation.node, updatedAt });
      if (!node) continue;
      nodes.push(node);
      applied += 1;
      continue;
    }
    if (blocked.has(operation.nodeId)) continue;
    if (operation.op === 'delete') {
      const before = nodes.length;
      nodes = nodes.filter((node) => node.id !== operation.nodeId);
      if (nodes.length !== before) applied += 1;
      continue;
    }
    nodes = nodes.map((node) => {
      if (node.id !== operation.nodeId) return node;
      applied += 1;
      return normalizeNode({ ...node, ...operation.patch, id: node.id, updatedAt }) || node;
    });
  }

  return {
    ok: true,
    applied,
    skipped,
    proposal: { ...proposal, status: 'applied' },
    doc: { ...doc, nodes, revision: doc.revision + 1, updatedAt }
  };
}

export function rejectProposal(proposal: WorkspaceProposal): WorkspaceProposal {
  return { ...proposal, status: 'rejected' };
}

/**
 * Render a preview as the block a terminal or panel shows before Apply.
 *
 * Deliberately plain text: it has to read the same in the CLI, in a canvas
 * card, and in a receipt, and anything richer would diverge between them.
 */
export function formatPreview(preview: ProposalPreview): string {
  const lines: string[] = [preview.intent, ''];
  for (const operation of preview.operations) {
    const mark = operation.op === 'create' ? '+' : operation.op === 'delete' ? '-' : '~';
    const detail = operation.changes.length
      ? ` (${operation.changes.map((change) => change.field).join(', ')})`
      : '';
    lines.push(`${mark} ${operation.title}${detail}${operation.conflict ? `  ⚠ ${operation.conflict}` : ''}`);
  }
  lines.push('', preview.summary + (preview.conflicts ? ` · ${preview.conflicts} need attention` : ''));
  if (preview.stale) lines.push('The canvas changed since this was proposed.');
  return lines.join('\n');
}
