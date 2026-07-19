import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createPilotSubmission: vi.fn() }));

vi.mock('../../lib/server/pilots', () => ({ createPilotSubmission: mocks.createPilotSubmission }));
import { actions } from '../../src/routes/(app)/pilot/+page.server';

function event(fields: Record<string, string>) {
  return { request: new Request('http://localhost/pilot', { method: 'POST', body: new URLSearchParams(fields) }) } as never;
}

describe('pilot page action contract', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.createPilotSubmission.mockResolvedValue(undefined); });

  it('rejects missing required fields', async () => {
    const result = await actions.default(event({ name: 'Ada' }));
    expect(result).toMatchObject({ status: 400, data: { message: 'Please complete every step before submitting.' } });
    expect(mocks.createPilotSubmission).not.toHaveBeenCalled();
  });

  it('requires explicit $500 pilot consent', async () => {
    const result = await actions.default(event({ name:'Ada',email:'ada@example.com',project_summary:'Project',agent_pref:'codex',apple_silicon:'yes',task_idea:'First task',timeline:'this-week' }));
    expect(result).toMatchObject({ status: 400, data: { message: 'Please confirm the $500 pilot fee before submitting.' } });
    expect(mocks.createPilotSubmission).not.toHaveBeenCalled();
  });

  it('calls the pilots service with a normalized submission', async () => {
    const result = await actions.default(event({ name:'  Ada Lovelace  ',email:' ADA@Example.com ',project_summary:'  Governed research  ',agent_pref:'claude-code',apple_silicon:'no',task_idea:'  Index my notes  ',timeline:'  next-2-weeks ',pilot_consent:'yes' }));
    expect(result).toEqual({ success: true });
    expect(mocks.createPilotSubmission).toHaveBeenCalledWith({ name:'Ada Lovelace',email:'ada@example.com',project_summary:'Governed research',agent_pref:'claude-code',apple_silicon:false,task_idea:'Index my notes',timeline:'next-2-weeks',source:'pilot-page' });
  });
});
