import { describe, expect, it } from 'vitest';
import { classifyVoiceEngineIntent, interpretVoiceUtterance } from '@/lib/voice/interpreter';

describe('voice intent', () => {
  it('classifies command intent for action language', () => {
    expect(classifyVoiceEngineIntent('send the update to Sam')).toEqual({ mode: 'act', confidence: 0.86 });
  });

  it('extracts action mode for send request', () => {
    const context = {
      snapshotAt: new Date().toISOString(),
      platform: 'mac' as const,
      references: []
    };
    const intent = interpretVoiceUtterance('send it now', context);
    expect(intent.mode).toBe('act');
  });

  it('detects backtrack language', () => {
    const intent = interpretVoiceUtterance('move the wall six feet no actually four feet', {
      snapshotAt: new Date().toISOString(),
      platform: 'mac',
      references: []
    });
    expect(intent.backtrack).toBeDefined();
    expect(intent.backtrack?.final).toMatch(/four feet/);
    expect(intent.mode).toBe('edit');
    expect(typeof intent.utterance).toBe('string');
  });
});
