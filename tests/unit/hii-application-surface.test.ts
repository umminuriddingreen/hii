import { describe, expect, it } from 'vitest';
import { applicationSeed } from '../../lib/workspace/application-seed';
import type { HiiApplicationManifest } from '../../lib/client/hii-bridge';

const waymark: HiiApplicationManifest = {
  schemaVersion: 1,
  id: 'community.waymark.location-studio',
  name: 'Waymark',
  version: '0.2.0-beta',
  developer: 'Waymark Labs',
  summary: 'Governed location studio',
  icon: 'location.circle',
  surfaces: { canvas: { surface: 'waymark-location', width: 1080, height: 720 } },
  capabilities: ['hii.location.preview'],
  builtIn: true
};

describe('shared HII application surface', () => {
  it('turns a CLI-owned manifest into a receipt-linked canvas app', () => {
    const seed = applicationSeed(waymark, 'bar', '/tmp/launch-receipt.json');
    expect(seed).toMatchObject({
      type: 'app',
      w: 1080,
      h: 720,
      payload: {
        surface: 'waymark-location',
        applicationId: waymark.id,
        launchSource: 'bar',
        launchReceiptPath: '/tmp/launch-receipt.json'
      },
      object: {
        status: 'ready',
        proofRefs: ['/tmp/launch-receipt.json']
      }
    });
  });

  it('does not create a second node for the canvas root itself', () => {
    expect(applicationSeed({
      ...waymark,
      id: 'hii.canvas',
      surfaces: { canvas: { surface: 'canvas-root', width: 1440, height: 960 } }
    }, 'bar')).toBeNull();
  });

  it('keeps unknown adapters visibly partial unless they provide a sandboxed entry URL', () => {
    expect(applicationSeed({
      ...waymark,
      id: 'studio.agent.app',
      surfaces: { canvas: { surface: 'agent-surface', width: 900, height: 620 } }
    }, 'agent')?.object?.status).toBe('partial');
  });

  it('recognizes the bundled HII Link adapter as ready', () => {
    expect(applicationSeed({
      ...waymark,
      id: 'hii.link',
      surfaces: { canvas: { surface: 'hii-link', width: 920, height: 640 } }
    }, 'bar')?.object?.status).toBe('ready');
  });
});
