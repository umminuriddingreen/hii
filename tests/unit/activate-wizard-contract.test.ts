import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const activate = readFileSync('src/routes/(app)/activate/+page.svelte', 'utf8');

describe('activation wizard contract', () => {
  it('implements the frozen six-step activation flow', () => {
    expect(activate).toContain('let step = $state(1)');
    expect(activate).toContain('{step} of 6');
    expect(activate).toContain("activationRequest<DetectionResponse>('detect')");
    expect(activate).toContain("activationRequest<Inventory>('inventory'");
    expect(activate).toContain("activationRequest<CreateResponse>('create'");
    expect(activate).toContain("activationRequest<StartResponse>('start'");
    expect(activate).toContain("activationRequest<StatusResponse>('status'");
    expect(activate).toContain('setInterval(() => void checkStatus(), 3000)');
  });

  it('keeps approval explicit and exposes the required task presets', () => {
    expect(activate).toContain('I approve this project context.');
    expect(activate).toContain('disabled={!approved || busy}');
    expect(activate).toContain('Explain this project and one next action.');
    expect(activate).toContain('Make one small reversible improvement.');
    expect(activate).toContain('Verify an artifact and produce a receipt.');
  });

  it('supports desktop folder picking, local mock fixtures, and complete receipts', () => {
    expect(activate).toContain('window as Window &');
    expect(activate).toContain('__TAURI__');
    expect(activate).toContain('VITE_ACTIVATION_MOCK');
    expect(activate).toContain("new URLSearchParams(location.search).get('mock') === '1'");
    for (const label of ['Summary', 'Outcome', 'Verification', 'Checks', 'Proof paths']) {
      expect(activate).toContain(label);
    }
  });

  it('records a privacy-safe first-win journey through the local activation contract', () => {
    expect(activate).toContain('journeyId = crypto.randomUUID()');
    expect(activate).toContain('JSON.stringify({ action, journeyId, ...params })');
    expect(activate).toContain('First win journey');
    expect(activate).toContain('without external analytics or captured task content');
    expect(activate).toContain('activationJourney.elapsedSeconds');
  });

  it('uses the HII founder-beta visual tokens', () => {
    for (const token of ['--paper:', '--ink:', '--blue:', '--acid:']) expect(activate).toContain(token);
  });
});
