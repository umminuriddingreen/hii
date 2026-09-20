'use client';

// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { useMemo } from 'react';
import { workspaceContextAnchorLabel, normalizeWorkspaceContextAnchor } from '@/lib/workspace/context-anchor';
import { workspaceRunBoundaryManifest } from '@/lib/workspace/run-boundary';
import { visibleRunOutput } from '@/lib/workspace/run-output';
import {
  terminalRunMessage,
  workspaceRunEvidence,
  workspaceRunProgress,
  type RunProgressStep
} from '@/lib/workspace/run-progress';
import type { WorkspaceNode } from '@/lib/workspace/types';

/**
 * How a bounded run presents itself on the canvas.
 *
 * Until now a `run` node fell through `NodeBody`'s dispatch to a monospace
 * `<pre>` of its raw payload, so the one object type that carries approval,
 * progress, verification and a receipt was the one object type that showed
 * none of them. Every module this file reads — progress, evidence, boundary,
 * anchors, output extraction — was already written and unit-tested; only the
 * render site was missing.
 *
 * Three states, because a run is only ever in one of three situations the user
 * can act on: it needs a decision, it is working, or it is finished and owes
 * evidence.
 */

type RunBodyProps = {
  node: WorkspaceNode;
  onApprove?: () => void;
  onStop?: () => void;
  onOpenProof?: (receiptPath: string) => void;
};

const PENDING = new Set(['waiting_approval', 'proposed']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function text(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function contextItems(node: WorkspaceNode) {
  return Array.isArray(node.payload.context)
    ? node.payload.context.filter(
        (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)
      )
    : [];
}

function ProgressRail({ steps }: { steps: RunProgressStep[] }) {
  return (
    <ol className="hii-run-rail" aria-label="Run progress">
      {steps.map((step, index) => (
        <li key={step.id} className="hii-run-step" data-state={step.state}>
          <span className="hii-run-step-mark" aria-hidden="true">
            {step.state === 'done' ? '✓' : step.state === 'attention' ? '!' : index + 1}
          </span>
          <div className="hii-run-step-copy">
            <strong>{step.label}</strong>
            <span className="hii-run-step-state">{step.state}</span>
            <p>{step.detail}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * The manifest the human approves.
 *
 * Every field shown here is one the approval is *about*: what will be read, on
 * whose authority, and with what integrity. A blocked item is styled as blocked
 * rather than omitted, because a manifest that quietly drops what it cannot use
 * is not the manifest that was approved.
 */
function ContextManifest({ node }: { node: WorkspaceNode }) {
  const items = contextItems(node);
  const fingerprint = text(node.payload.contextFingerprint);

  if (!items.length) {
    return (
      <p className="hii-run-note" data-tone="warn">
        No canvas objects are in scope. This run still carries the workspace authority shown below.
      </p>
    );
  }

  return (
    <>
      <div className="hii-run-manifest">
        {items.map((item, index) => {
          const anchor = normalizeWorkspaceContextAnchor(item.anchor);
          const blocked = text(item.access) === 'blocked';
          return (
            <article key={text(item.id, String(index))} className="hii-run-context-item" data-blocked={blocked || undefined}>
              <header>
                <strong>{text(item.title, 'Untitled object')}</strong>
                {item.access ? <span className="hii-run-badge">{text(item.access).replaceAll('-', ' ')}</span> : null}
              </header>
              <span className="hii-run-context-meta">
                {[text(item.type), text(item.provenance) || text(item.owner)].filter(Boolean).join(' · ')}
              </span>
              {item.source ? <span className="hii-run-context-path">{text(item.source)}</span> : null}
              {item.expectedSha256 ? (
                <span className="hii-run-context-hash">sha256 {text(item.expectedSha256).slice(0, 16)}…</span>
              ) : null}
              {anchor ? <span className="hii-run-anchor">human focus · {workspaceContextAnchorLabel(anchor)}</span> : null}
              {item.excerpt ? <p className="hii-run-context-excerpt">{text(item.excerpt)}</p> : null}
              {item.blockedReason ? <p className="hii-run-note" data-tone="danger">{text(item.blockedReason)}</p> : null}
            </article>
          );
        })}
      </div>
      {fingerprint ? (
        <div className="hii-run-fingerprint">
          <span>context fingerprint</span>
          <code>{fingerprint.slice(0, 24)}</code>
        </div>
      ) : null}
    </>
  );
}

export function RunBody({ node, onApprove, onStop, onOpenProof }: RunBodyProps) {
  const status = text(node.payload.status, text(node.object?.status, 'waiting_approval'));
  const job = (node.payload.job ?? null) as Parameters<typeof workspaceRunEvidence>[0];
  const receipt = (node.payload.receipt ?? null) as Parameters<typeof workspaceRunEvidence>[1];
  const items = contextItems(node);

  const boundary = useMemo(
    () =>
      workspaceRunBoundaryManifest({
        context: items.map((item) => ({
          id: text(item.id),
          title: text(item.title),
          type: text(item.type),
          source: text(item.source)
        })),
        workspaceRoot: node.payload.workspaceRoot
      }),
    [items, node.payload.workspaceRoot]
  );

  const steps = useMemo(
    () =>
      workspaceRunProgress({
        status,
        contextCount: items.length,
        maxSteps: Number(node.payload.maxSteps) || undefined,
        workspaceRoot: text(node.payload.workspaceRoot),
        job,
        receipt
      }),
    [status, items.length, node.payload.maxSteps, node.payload.workspaceRoot, job, receipt]
  );

  const evidence = useMemo(() => workspaceRunEvidence(job, receipt), [job, receipt]);
  const answer = useMemo(() => visibleRunOutput(node.payload.output), [node.payload.output]);
  const receiptPath = text(node.payload.receiptPath);
  const rawOutput = text(node.payload.output);

  return (
    <article className="hii-run" data-status={status}>
      <header className="hii-run-head">
        <span className="hii-run-eyebrow">
          {PENDING.has(status) ? 'Review before execution' : 'HII · bounded run'}
        </span>
        <h2>{text(node.payload.prompt, text(node.payload.title, 'Untitled intent'))}</h2>
      </header>

      {PENDING.has(status) ? (
        <section className="hii-run-section" aria-label="Execution context manifest">
          <h3>Execution context manifest</h3>
          <ContextManifest node={node} />

          <dl className="hii-run-boundary">
            <div>
              <dt>Read boundary</dt>
              <dd>{boundary.readScope}</dd>
            </div>
            <div>
              <dt>Write boundary</dt>
              <dd>{boundary.writeScope}</dd>
            </div>
            <div>
              <dt>External</dt>
              <dd>{boundary.externalScope}</dd>
            </div>
            <div>
              <dt>Secrets</dt>
              <dd>{boundary.secretPolicy}</dd>
            </div>
          </dl>

          {boundary.blocked ? (
            <p className="hii-run-note" data-tone="danger">
              {boundary.sensitiveCount > 0
                ? 'This manifest names credential-bearing sources. Remove them before this run can be approved.'
                : 'Choose a specific project folder before HII can resolve the run boundary.'}
            </p>
          ) : null}

          <button
            type="button"
            className="hii-run-approve"
            disabled={boundary.blocked || !onApprove}
            onClick={onApprove}
          >
            Approve bounded run
          </button>
        </section>
      ) : (
        <section className="hii-run-section" aria-label="Run state">
          <ProgressRail steps={steps} />

          {status === 'running' && onStop ? (
            <button type="button" className="hii-run-stop" onClick={onStop}>
              Stop bounded run
            </button>
          ) : null}

          {status === 'completed' ? (
            <div className="hii-run-receipt" data-tone="ok">
              <span className="hii-run-eyebrow">Verified receipt returned</span>
              <p>{text(receipt?.summary, answer) || 'The bounded workspace run completed.'}</p>
              <div className="hii-run-pills">
                <span>
                  {evidence.passingChecks} passing check{evidence.passingChecks === 1 ? '' : 's'}
                </span>
                <span>
                  {receipt?.artifacts?.length || 0} changed artifact
                  {receipt?.artifacts?.length === 1 ? '' : 's'}
                </span>
                {evidence.duration ? <span>{evidence.duration}</span> : null}
              </div>
            </div>
          ) : null}

          {TERMINAL.has(status) && status !== 'completed' ? (
            <div className="hii-run-receipt" data-tone={status === 'cancelled' ? 'warn' : 'danger'}>
              <span className="hii-run-eyebrow">Run {status}</span>
              {/* Never the raw log: a failure message the user can act on, with
                  the actual output kept one disclosure away. */}
              <p>{terminalRunMessage(status)}</p>
            </div>
          ) : null}

          {answer && !TERMINAL.has(status) ? <p className="hii-run-answer">{answer}</p> : null}

          <details className="hii-run-evidence">
            <summary>Inspect evidence</summary>
            {evidence.checks.length ? (
              <ul className="hii-run-checks">
                {evidence.checks.map((check, index) => (
                  <li key={`${check.command}-${index}`} data-ok={check.ok === true || undefined}>
                    <span>{check.ok ? 'ok' : '!!'}</span>
                    <code>{check.command}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hii-run-note">No verification checks were recorded.</p>
            )}
            {/* The raw output lives here and only here: one disclosure away
                from a failure message the user can act on. */}
            {evidence.logs.length ? (
              <pre className="hii-run-log">{evidence.logs.join('\n')}</pre>
            ) : rawOutput ? (
              <pre className="hii-run-log">{rawOutput}</pre>
            ) : null}
            {receiptPath ? (
              <button type="button" className="hii-run-proof" onClick={() => onOpenProof?.(receiptPath)}>
                <code>{receiptPath}</code>
              </button>
            ) : null}
          </details>
        </section>
      )}
    </article>
  );
}
