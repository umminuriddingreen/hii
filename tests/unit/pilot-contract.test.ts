import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  insert: vi.fn()
}));

vi.mock('../../lib/server/supabase', () => ({
  supabaseAdmin: () => ({ from: mocks.from })
}));

import { createPilotSubmission, updatePilotStatus } from '../../lib/server/pilots';

describe('founder-beta pilot data contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insert.mockResolvedValue({ error: null });
    mocks.from.mockReturnValue({ insert: mocks.insert });
  });

  it('validates and inserts a pilot submission through the service-role client', async () => {
    await createPilotSubmission({
      name: '  Ada Lovelace  ',
      email: ' ADA@example.com ',
      project_summary: '  Build a governed research agent.  ',
      agent_pref: 'codex',
      apple_silicon: true,
      source: ' founder referral '
    });

    expect(mocks.from).toHaveBeenCalledWith('pilots');
    expect(mocks.insert).toHaveBeenCalledWith({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      x_profile: null,
      project_summary: 'Build a governed research agent.',
      agent_pref: 'codex',
      pain: null,
      task_idea: null,
      timeline: null,
      apple_silicon: true,
      source: 'founder referral',
      notes: null
    });
  });

  it('rejects lifecycle statuses outside the contract before touching Supabase', async () => {
    await expect(updatePilotStatus('pilot-1', 'waitlisted' as never)).rejects.toThrow(
      'invalid pilot status'
    );
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each([
    [{ email: 'ada@example.com', project_summary: 'A project' }, 'name is required'],
    [{ name: 'Ada', project_summary: 'A project' }, 'email is required'],
    [{ name: 'Ada', email: 'ada@example.com' }, 'project_summary is required']
  ])('rejects submissions missing required fields', async (input, message) => {
    await expect(createPilotSubmission(input as never)).rejects.toThrow(message);
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
