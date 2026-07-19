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

function denied() {
  return json({ error: 'Local HII access required.' }, { status: 401 });
}

export const POST: RequestHandler = async ({ request }) => {
  if (!localTerminalAllowed(request)) return denied();
  const body = await request.json().catch(() => null);
  const action = typeof body?.action === 'string' ? body.action : '';

  try {
    if (action === 'detect') return json({ agents: await detectAgents() });
    if (action === 'inventory') {
      const items = inventoryContextRoot({
        rootPath: String(body?.rootPath || ''),
        approved: true,
        exclusions: Array.isArray(body?.exclusions) ? body.exclusions.map(String) : undefined
      }).map(({ absolutePath: _absolutePath, ...item }) => item);
      return json({
        rootPath: fs.realpathSync(path.resolve(String(body?.rootPath || ''))),
        items,
        count: items.length,
        totalBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0)
      });
    }
    if (action === 'create') {
      const project = createContextProject({
        rootPath: String(body?.rootPath || ''),
        name: body?.name,
        approved: true
      });
      const scan = scanContextProject(project.id, {
        exclusions: Array.isArray(body?.exclusions) ? body.exclusions.map(String) : undefined
      });
      return json({ project, scan }, { status: 201 });
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
      return json(await startActivationRun({
        projectId: String(body?.projectId || ''),
        agent: body?.agent,
        task: String(body?.task || '')
      }), { status: 201 });
    }
    if (action === 'status') return json(await readActivationReceipt(String(body?.activationId || '')));
    return json({ error: 'Unknown activation action.' }, { status: 400 });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Activation request failed.' }, { status: 400 });
  }
};
