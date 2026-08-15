import { NextResponse } from 'next/server';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';
import {
  createEcosystemCapture,
  ecosystemSummary,
  getEcosystemWorkflow,
  listEcosystemCaptures,
  listEcosystemEvents,
  listEcosystemWorkflows,
  recordEcosystemEvent,
  saveEcosystemWorkflow
} from '@/lib/server/hii-ecosystem';
import { comfyPromptHistory, comfyStatus, queueComfyPrompt } from '@/lib/server/hii-comfy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function denied(request: Request) {
  return localTerminalAllowed(request) ? null : NextResponse.json({ error: 'The HII ecosystem is local-only.' }, { status: 403 });
}

export async function GET(request: Request) {
  const rejection = denied(request);
  if (rejection) return rejection;
  const params = new URL(request.url).searchParams;
  try {
    switch (params.get('mode') || 'summary') {
      case 'summary': return NextResponse.json(await ecosystemSummary());
      case 'captures': return NextResponse.json({ captures: await listEcosystemCaptures(Number(params.get('limit')) || 80) });
      case 'workflows': return NextResponse.json({ workflows: await listEcosystemWorkflows(Number(params.get('limit')) || 80) });
      case 'events': return NextResponse.json({ events: await listEcosystemEvents(Number(params.get('limit')) || 80) });
      case 'comfy': return NextResponse.json(await comfyStatus());
      case 'comfy-history': return NextResponse.json(await comfyPromptHistory(params.get('promptId')));
      default: return NextResponse.json({ error: 'Unknown ecosystem mode.' }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not read HII ecosystem state.' }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const rejection = denied(request);
  if (rejection) return rejection;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'An ecosystem action payload is required.' }, { status: 400 });
  try {
    if (body.action === 'capture') {
      return NextResponse.json({ capture: await createEcosystemCapture(body) }, { status: 201 });
    }
    if (body.action === 'workflow.save') {
      return NextResponse.json({ workflow: await saveEcosystemWorkflow(body) }, { status: 201 });
    }
    if (body.action === 'event') {
      return NextResponse.json({ event: await recordEcosystemEvent(body) }, { status: 201 });
    }
    if (body.action === 'workflow.run') {
      if (body.approved !== true) throw new Error('Explicit approval is required before Create can queue a workflow.');
      const workflow = await getEcosystemWorkflow(body.workflowId);
      if (!workflow) throw new Error('The selected workflow does not exist.');
      try {
        const queued = await queueComfyPrompt(workflow.adapter.prompt);
        const event = await recordEcosystemEvent({
          mode: 'create',
          projectId: workflow.projectId,
          status: 'queued',
          summary: `${workflow.title} queued in ComfyUI`,
          object: { kind: 'run', id: queued.promptId },
          proofRefs: [`workflow:${workflow.id}@${workflow.revision}`, `sha256:${workflow.revisionHash}`]
        });
        return NextResponse.json({ queued, workflow, event }, { status: 202 });
      } catch (error) {
        await recordEcosystemEvent({
          mode: 'create',
          projectId: workflow.projectId,
          status: 'failed',
          summary: error instanceof Error ? error.message : 'ComfyUI could not queue the workflow.',
          object: { kind: 'workflow', id: workflow.id },
          proofRefs: [`sha256:${workflow.revisionHash}`]
        });
        throw error;
      }
    }
    if (body.action === 'workflow.refresh') {
      const workflow = await getEcosystemWorkflow(body.workflowId);
      if (!workflow) throw new Error('The selected workflow does not exist.');
      const promptId = String(body.promptId ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!promptId) throw new Error('A ComfyUI prompt id is required.');
      const history = await comfyPromptHistory(promptId);
      const record = history[promptId] && typeof history[promptId] === 'object'
        ? history[promptId] as Record<string, unknown>
        : null;
      if (!record) return NextResponse.json({ promptId, status: 'running', outputs: [] });
      const statusRecord = record.status && typeof record.status === 'object'
        ? record.status as Record<string, unknown>
        : {};
      const completed = statusRecord.completed === true || statusRecord.status_str === 'success';
      const outputs: string[] = [];
      const outputMap = record.outputs && typeof record.outputs === 'object'
        ? record.outputs as Record<string, unknown>
        : {};
      for (const output of Object.values(outputMap)) {
        if (!output || typeof output !== 'object') continue;
        const images = Array.isArray((output as Record<string, unknown>).images)
          ? (output as Record<string, unknown>).images as Array<Record<string, unknown>>
          : [];
        for (const image of images) {
          const filename = String(image.filename || '').replace(/[\u0000-\u001F\u007F]/g, '');
          const subfolder = String(image.subfolder || '').replace(/[\u0000-\u001F\u007F]/g, '');
          if (filename) outputs.push([subfolder, filename].filter(Boolean).join('/'));
        }
      }
      const status = completed ? 'completed' : 'running';
      const existing = (await listEcosystemEvents(200)).find((event) => event.object?.kind === 'run' && event.object.id === promptId && event.status === status);
      const event = existing || await recordEcosystemEvent({
        mode: 'create',
        projectId: workflow.projectId,
        status,
        summary: completed ? `${workflow.title} completed with ${outputs.length} output${outputs.length === 1 ? '' : 's'}` : `${workflow.title} is running in ComfyUI`,
        object: { kind: 'run', id: promptId },
        proofRefs: [`workflow:${workflow.id}@${workflow.revision}`, `sha256:${workflow.revisionHash}`, ...outputs.map((output) => `comfy-output:${output}`)]
      });
      return NextResponse.json({ promptId, status, outputs, event });
    }
    return NextResponse.json({ error: 'Unknown ecosystem action.' }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not update HII ecosystem state.' }, { status: 400 });
  }
}
