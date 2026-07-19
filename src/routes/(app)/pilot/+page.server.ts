import { fail } from '@sveltejs/kit';
import { createPilotSubmission, type PilotAgentPreference } from '../../../../lib/server/pilots';
import type { Actions, PageServerLoad } from './$types';

const AGENTS = new Set<PilotAgentPreference>(['codex', 'claude-code', 'ollama']);

function text(form: FormData, name: string): string {
  return String(form.get(name) ?? '').trim();
}

export const load: PageServerLoad = () => ({
  bookingUrl: process.env.PUBLIC_PILOT_CAL_URL?.trim() || null
});

export const actions: Actions = {
  default: async ({ request }) => {
    const form = await request.formData();
    const name = text(form, 'name');
    const email = text(form, 'email').toLowerCase();
    const projectSummary = text(form, 'project_summary');
    const agentPref = text(form, 'agent_pref') as PilotAgentPreference;
    const appleSilicon = text(form, 'apple_silicon');
    const taskIdea = text(form, 'task_idea');
    const timeline = text(form, 'timeline');
    const consent = form.get('pilot_consent') === 'yes';
    const values = { name, email, project_summary: projectSummary, agent_pref: agentPref, apple_silicon: appleSilicon, task_idea: taskIdea, timeline };

    if (!name || !email || !projectSummary || !agentPref || !appleSilicon || !taskIdea || !timeline) {
      return fail(400, { message: 'Please complete every step before submitting.', values });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return fail(400, { message: 'Please enter a valid email address.', values });
    }
    if (!AGENTS.has(agentPref)) {
      return fail(400, { message: 'Please choose a supported agent preference.', values });
    }
    if (appleSilicon !== 'yes' && appleSilicon !== 'no') {
      return fail(400, { message: 'Please tell us whether you use an Apple Silicon Mac.', values });
    }
    if (!consent) {
      return fail(400, { message: 'Please confirm the $500 pilot fee before submitting.', values });
    }

    try {
      await createPilotSubmission({
        name,
        email,
        project_summary: projectSummary,
        agent_pref: agentPref,
        apple_silicon: appleSilicon === 'yes',
        task_idea: taskIdea,
        timeline,
        source: 'pilot-page'
      });
      return { success: true };
    } catch (error) {
      const unconfigured = error instanceof Error && error.message.includes('not configured');
      return fail(503, {
        message: unconfigured
          ? 'Pilot intake is being connected. Please try again soon.'
          : 'We could not save your application. Please try again.',
        values
      });
    }
  }
};
