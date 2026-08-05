import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import fs from 'node:fs';
import path from 'node:path';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';
import {
  contextProjectState,
  createContextProject,
  inventoryContextRoot,
  scanContextProject,
  setContextSourceState
} from '@/lib/server/hii-context-dock';
import { detectAgents, readActivationReceipt, startActivationRun } from '@/lib/server/hii-activation';
import {
  activationFunnelSummary,
  readActivationJourney,
  recordActivationJourneyMilestone,
  type ActivationJourneyMetadata,
  type ActivationJourneyMilestone
} from '@/lib/server/hii-activation-journey';

function denied() {
  return json({ error: 'Local HII access required.' }, { status: 401 });
}

async function recordMilestone(
  journeyId: unknown,
  milestone: ActivationJourneyMilestone,
  options: { activationId?: string; metadata?: ActivationJourneyMetadata } = {}
) {
  if (typeof journeyId !== 'string' || !journeyId.trim()) return null;
  try {
    await recordActivationJourneyMilestone({
      journeyId,
      milestone,
      activationId: options.activationId,
      metadata: options.metadata
    });
    return null;
  } catch {
    return 'The activation continued, but its local journey milestone could not be recorded.';
  }
}

export const POST: RequestHandler = async ({ request }) => {
  if (!localTerminalAllowed(request)) return denied();
  const body = await request.json().catch(() => null);
  const action = typeof body?.action === 'string' ? body.action : '';

  try {
    if (action === 'detect') {
      const agents = await detectAgents();
      const journeyWarning = await recordMilestone(body?.journeyId, 'agents_detected', {
        metadata: { installedAgents: agents.filter((agent) => agent.installed).length }
      });
      return json({ agents, ...(journeyWarning ? { journeyWarning } : {}) });
    }
    if (action === 'inventory') {
      const items = inventoryContextRoot({
        rootPath: String(body?.rootPath || ''),
        approved: true,
        exclusions: Array.isArray(body?.exclusions) ? body.exclusions.map(String) : undefined
      }).map(({ absolutePath: _absolutePath, ...item }) => item);
      const totalBytes = items.reduce((sum, item) => sum + item.sizeBytes, 0);
      const journeyWarning = await recordMilestone(body?.journeyId, 'context_previewed', {
        metadata: { itemCount: items.length, totalBytes }
      });
      return json({
        rootPath: fs.realpathSync(path.resolve(String(body?.rootPath || ''))),
        items,
        count: items.length,
        totalBytes,
        ...(journeyWarning ? { journeyWarning } : {})
      });
    }
    if (action === 'create') {
      const rootPath = String(body?.rootPath || '');
      const exclusions = Array.isArray(body?.exclusions) ? body.exclusions.map(String) : undefined;
      const approvedItems = inventoryContextRoot({ rootPath, approved: true, exclusions });
      if (approvedItems.length === 0) {
        return json(
          { error: 'Choose a project folder with at least one supported file before continuing.' },
          { status: 400 }
        );
      }
      const project = createContextProject({
        rootPath,
        name: body?.name,
        approved: true
      });
      const scan = scanContextProject(project.id, {
        exclusions
      });
      const sourceCount = contextProjectState(project.id)?.sources.length ?? 0;
      const journeyWarning = await recordMilestone(body?.journeyId, 'context_approved', {
        metadata: { sourceCount }
      });
      return json({ project, scan, ...(journeyWarning ? { journeyWarning } : {}) }, { status: 201 });
    }
    if (action === 'state') {
      const state = contextProjectState(String(body?.projectId || ''));
      return state ? json(state) : json({ error: 'Context project not found.' }, { status: 404 });
    }
    if (action === 'sourceState') {
      setContextSourceState(String(body?.sourceId || ''), {
        pinned: typeof body?.pinned === 'boolean' ? body.pinned : undefined,
        excluded: typeof body?.excluded === 'boolean' ? body.excluded : undefined
      });
      return json({ ok: true });
    }
    if (action === 'start') {
      const started = await startActivationRun({
        projectId: String(body?.projectId || ''),
        agent: body?.agent,
        task: String(body?.task || '')
      });
      const journeyWarning = await recordMilestone(body?.journeyId, 'run_started', {
        activationId: started.activationId,
        metadata: { agent: body?.agent === 'claude' ? 'claude' : 'codex', runKind: started.runKind }
      });
      return json({ ...started, ...(journeyWarning ? { journeyWarning } : {}) }, { status: 201 });
    }
    if (action === 'status') {
      const activationId = String(body?.activationId || '');
      const result = await readActivationReceipt(activationId);
      const journeyWarning = result.status === 'completed'
        ? await recordMilestone(body?.journeyId, 'receipt_verified', { activationId })
        : result.status === 'failed'
          ? await recordMilestone(body?.journeyId, 'run_failed', { activationId })
          : null;
      const journey = typeof body?.journeyId === 'string' && body.journeyId.trim()
        ? await readActivationJourney(body.journeyId).catch(() => null)
        : null;
      return json({ ...result, journey, ...(journeyWarning ? { journeyWarning } : {}) });
    }
    if (action === 'funnel') return json(await activationFunnelSummary());
    return json({ error: 'Unknown activation action.' }, { status: 400 });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Activation request failed.' }, { status: 400 });
  }
};
