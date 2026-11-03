/**
 * Creating a variant of a workspace object.
 *
 * The first complete generative branch: select a source, say how it should
 * differ, review what will be sent, approve, run bounded, and get a new object
 * beside the original with typed lineage back to it.
 *
 * Two properties this is built around. The source is never touched — a variant
 * is a sibling, not an edit, so a generation that goes wrong costs nothing. And
 * a failed generation produces no branch at all: the variant object is
 * materialised from the run's *declared outcome*, so a run that did not produce
 * what it promised leaves the canvas exactly as it was.
 *
 * The agent does not write the workspace. It writes a file inside the approved
 * root, and HII materialises that into an object once the run's completion
 * assessment says the declared outcome was met.
 */

import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { qualifiesForHighTrust } from './proof-policy.ts';
import { resolveContextRefs, reviewContextResolution } from './context-refs.ts';
import { applyGraphMutation } from './operational-graph-mutations.ts';
import { workspaceObjectId } from './operational-object-store.ts';
import { readWorkspace, writeWorkspace } from './workspace-store.ts';
import type { ReviewedContextManifest } from '../context/refs.ts';
import type { WorkspaceDoc, WorkspaceNode, WorkspaceNodeType } from '../workspace/types.ts';

/** Media a variant can currently be. Anything else is refused, not faked. */
export type VariantMedium = 'text' | 'document' | 'image';

const supportedMedia: Record<VariantMedium, { extensions: string[]; nodeType: WorkspaceNodeType }> = {
  text: { extensions: ['md', 'txt'], nodeType: 'note' },
  document: { extensions: ['md', 'html', 'json'], nodeType: 'document' },
  image: { extensions: ['png', 'jpg', 'jpeg', 'webp'], nodeType: 'image' }
};

/** Horizontal gap between a source and the variant placed beside it. */
const BRANCH_GAP = 48;

export type VariantProposal = {
  branchId: string;
  workspaceId: string;
  workspaceRevision: number;
  sourceNodeId: string;
  sourceTitle: string;
  medium: VariantMedium;
  instruction: string;
  /** Where the run must write its result, relative to the approved root. */
  requiredArtifact: string;
  /** What the run's contract will declare, shown before approval. */
  declaredOutcome: { kind: 'file-artifact'; artifacts: string[] };
  manifest: ReviewedContextManifest;
  placement: { x: number; y: number; w: number; h: number };
  notice: string;
};

function clean(value: unknown, max: number) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanId(value: unknown) {
  return clean(value, 120).replace(/[^a-zA-Z0-9_-]/g, '');
}

function variantExtension(medium: VariantMedium, source: WorkspaceNode) {
  const sourceExtension = path
    .extname(String(source.payload.path ?? source.payload.url ?? ''))
    .replace('.', '')
    .toLowerCase();
  const allowed = supportedMedia[medium].extensions;
  return allowed.includes(sourceExtension) ? sourceExtension : allowed[0];
}

/**
 * Where the variant goes: immediately to the right of its source.
 *
 * Deliberately computed here rather than in the renderer. Placement is part of
 * what the human approves — they should see where the branch will appear before
 * it appears — and the canvas keeps rendering nodes the way it always has.
 */
export function branchPlacement(source: WorkspaceNode, existing: WorkspaceNode[]) {
  const siblings = existing.filter(
    (node) => node.object?.parentId === source.id && node.id !== source.id
  );
  return {
    x: Math.round(source.x + source.w + BRANCH_GAP + siblings.length * (source.w + BRANCH_GAP)),
    y: Math.round(source.y),
    w: source.w,
    h: source.h
  };
}

/**
 * Build the branch proposal a human reviews before approving.
 *
 * Nothing is created here. The proposal names the source, the instruction, the
 * artifact the run must produce, and the exact context that would be sent —
 * frozen with a fingerprint so the approval cannot be carried onto anything
 * else.
 */
export async function prepareVariantBranch(input: {
  workspaceId?: unknown;
  sourceNodeId?: unknown;
  instruction?: unknown;
  medium?: unknown;
}): Promise<VariantProposal> {
  const workspaceIdInput = cleanId(input.workspaceId);
  const doc = await readWorkspace(workspaceIdInput || undefined);
  const workspaceId = workspaceIdInput || 'default';
  const sourceNodeId = cleanId(input.sourceNodeId);
  const source = doc.nodes.find((node) => node.id === sourceNodeId);
  if (!source) throw new Error('Select an object on the canvas to create a variant of.');

  const instruction = clean(input.instruction, 2000);
  if (instruction.length < 4) {
    throw new Error('Say how the variant should differ, in at least 4 characters.');
  }
  const medium = clean(input.medium, 20) as VariantMedium;
  if (!supportedMedia[medium]) {
    // Refused rather than approximated. Claiming support for a medium HII cannot
    // actually produce would make the lineage a lie.
    throw new Error(
      `Variants are not supported for "${medium || 'unknown'}" yet. Supported: ${Object.keys(supportedMedia).join(', ')}.`
    );
  }

  const branchId = randomUUID();
  const resolution = await resolveContextRefs([
    { kind: 'workspace-object', id: sourceNodeId, scope: workspaceId }
  ]);
  const blocking = resolution.unresolved.filter((item) => item.status !== 'stale');
  if (blocking.length) {
    throw new Error(`The source object could not be read: ${blocking[0].notice ?? blocking[0].status}.`);
  }
  const manifest = reviewContextResolution(resolution, {
    workspaceId,
    workspaceRevision: doc.revision
  });

  const requiredArtifact = path.join(
    '.hii-variants',
    branchId,
    `variant.${variantExtension(medium, source)}`
  );
  return {
    branchId,
    workspaceId,
    workspaceRevision: doc.revision,
    sourceNodeId,
    sourceTitle: manifest.entries[0]?.title ?? sourceNodeId,
    medium,
    instruction,
    requiredArtifact,
    declaredOutcome: { kind: 'file-artifact', artifacts: [requiredArtifact] },
    manifest,
    placement: branchPlacement(source, doc.nodes),
    notice: `The variant will be created beside "${manifest.entries[0]?.title ?? sourceNodeId}". The original is not modified.`
  };
}

/** The goal text the bounded run receives. */
export function variantRunGoal(proposal: VariantProposal) {
  return [
    `Create a variant of the attached ${proposal.medium}.`,
    `How it should differ: ${proposal.instruction}`,
    `Write the result to ${proposal.requiredArtifact} and nothing else.`,
    'Do not modify the source. The variant is a new file beside it.'
  ].join('\n');
}

export type VariantOutcome =
  | { materialized: false; reason: string }
  | {
      materialized: true;
      workspaceId: string;
      revision: number;
      variantNodeId: string;
      sourceNodeId: string;
      relations: string[];
      verified: boolean;
    };

type CompletionVerdict = { completed: boolean; legacy: boolean; proofStrength: string; reasons: string[] };

/**
 * Turn a finished run into a variant object, or explain why it did not.
 *
 * The gate is the run's completion assessment, not the presence of a file: a run
 * that produced something incidentally never asked to be trusted, and a failed
 * run must not leave a successful-looking branch on the canvas.
 */
export async function materializeVariantBranch(input: {
  proposal: VariantProposal;
  runId: string;
  receiptPath?: string | null;
  workspaceRoot: string;
  completion: CompletionVerdict;
}): Promise<VariantOutcome> {
  const { proposal, completion } = input;
  if (!completion.completed) {
    return {
      materialized: false,
      reason: `The run did not meet its declared outcome, so no variant was created. ${completion.reasons.join(' ')}`.trim()
    };
  }

  const artifactPath = path.join(input.workspaceRoot, proposal.requiredArtifact);
  let info;
  try {
    info = await stat(artifactPath);
  } catch {
    return { materialized: false, reason: 'The declared variant artifact is not on disk.' };
  }
  if (!info.isFile() || info.size === 0) {
    return { materialized: false, reason: 'The declared variant artifact is empty or not a file.' };
  }

  const doc = await readWorkspace(proposal.workspaceId);
  const source = doc.nodes.find((node) => node.id === proposal.sourceNodeId);
  if (!source) {
    return { materialized: false, reason: 'The source object is no longer on the canvas.' };
  }

  const now = new Date().toISOString();
  const variantNodeId = `variant-${proposal.branchId.slice(0, 12)}`;
  const placement = branchPlacement(source, doc.nodes);
  const payload: Record<string, unknown> = {
    path: artifactPath,
    title: `${proposal.manifest.entries[0]?.title ?? source.id} — variant`,
    variantOf: source.id,
    instruction: proposal.instruction,
    runId: input.runId,
    ...(input.receiptPath ? { receiptPath: input.receiptPath } : {})
  };
  if (proposal.medium !== 'image') {
    // Text and documents carry their content so the canvas can show them without
    // a second read. An image stays a path.
    payload.content = (await readFile(artifactPath, 'utf8')).slice(0, 20000);
  }

  const variant: WorkspaceNode = {
    id: variantNodeId,
    type: supportedMedia[proposal.medium].nodeType,
    x: placement.x,
    y: placement.y,
    w: placement.w,
    h: placement.h,
    z: doc.nextZ,
    createdAt: now,
    updatedAt: now,
    object: {
      kind: 'artifact',
      owner: 'agent',
      parentId: source.id,
      ...(input.receiptPath ? { proofRefs: [input.receiptPath] } : {})
    },
    ...(source.frameId ? { frameId: source.frameId } : {}),
    payload
  };

  // The source is carried through untouched. A variant is a sibling, not an edit.
  const next: WorkspaceDoc = {
    ...doc,
    nodes: [...doc.nodes, variant],
    nextZ: doc.nextZ + 1,
    updatedAt: now
  };
  const saved = await writeWorkspace(next, doc.revision);

  const relations = recordVariantLineage({
    workspaceId: proposal.workspaceId,
    sourceNodeId: source.id,
    variantNodeId,
    runId: input.runId,
    receiptPath: input.receiptPath ?? null,
    branchId: proposal.branchId,
    completion
  });

  return {
    materialized: true,
    workspaceId: proposal.workspaceId,
    revision: saved.revision,
    variantNodeId,
    sourceNodeId: source.id,
    relations: relations.recorded,
    verified: relations.verified
  };
}

/**
 * Typed lineage for a branch.
 *
 * VARIANT_OF and DERIVED_FROM say where it came from; GENERATED_BY says what
 * made it. VERIFIED_BY is recorded only when the run's proof is declared and
 * satisfied — the graph refuses it otherwise, and that refusal is reported
 * rather than swallowed, so an unverified branch is visibly unverified instead
 * of quietly indistinguishable from a verified one.
 */
export function recordVariantLineage(input: {
  workspaceId: string;
  sourceNodeId: string;
  variantNodeId: string;
  runId: string;
  receiptPath: string | null;
  branchId: string;
  completion: CompletionVerdict;
}) {
  const spaceId = input.workspaceId;
  const from = workspaceObjectId(spaceId, input.variantNodeId);
  const to = workspaceObjectId(spaceId, input.sourceNodeId);
  const actor = {
    actorId: 'hii:workspace-variant',
    runId: input.runId,
    ...(input.receiptPath ? { receiptId: input.receiptPath } : {}),
    proof: input.completion
  };
  const recorded: string[] = [];
  for (const type of ['VARIANT_OF', 'DERIVED_FROM'] as const) {
    applyGraphMutation({
      spaceId,
      type: 'CREATE_RELATION',
      actor,
      idempotencyKey: `${input.branchId}:${type}`,
      payload: {
        id: `${input.branchId}:${type.toLowerCase()}`,
        type,
        fromObjectId: from,
        toObjectId: to,
        properties: { branchId: input.branchId, runId: input.runId }
      }
    });
    recorded.push(type);
  }

  // GENERATED_BY points at the run that made it. The run is represented by the
  // variant's own provenance until runs are first-class objects, so this is
  // recorded as a self-referential edge carrying the run id rather than a
  // dangling edge to an object that does not exist.
  applyGraphMutation({
    spaceId,
    type: 'CREATE_RELATION',
    actor,
    idempotencyKey: `${input.branchId}:GENERATED_BY`,
    payload: {
      id: `${input.branchId}:generated_by`,
      type: 'GENERATED_BY',
      fromObjectId: from,
      toObjectId: from,
      properties: { runId: input.runId, receipt: input.receiptPath }
    }
  });
  recorded.push('GENERATED_BY');

  let verified = false;
  if (qualifiesForHighTrust(input.completion, 'verified-by-relation').qualifies) {
    applyGraphMutation({
      spaceId,
      type: 'CREATE_RELATION',
      actor,
      idempotencyKey: `${input.branchId}:VERIFIED_BY`,
      payload: {
        id: `${input.branchId}:verified_by`,
        type: 'VERIFIED_BY',
        fromObjectId: from,
        toObjectId: from,
        properties: { runId: input.runId, receipt: input.receiptPath }
      }
    });
    recorded.push('VERIFIED_BY');
    verified = true;
  }
  return { recorded, verified };
}
