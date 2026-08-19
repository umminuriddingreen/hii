// SPDX-License-Identifier: LicenseRef-BSL-1.1
import type { HiiApplicationManifest } from '@/lib/client/hii-bridge';
import type { NodeSeed } from '@/lib/workspace/ingest';

export function applicationSeed(application: HiiApplicationManifest, source: string, receiptPath?: string): NodeSeed | null {
  const canvas = application.surfaces.canvas;
  if (!canvas || canvas.surface === 'canvas-root') return null;
  const now = new Date().toISOString();
  return {
    type: 'app',
    w: canvas.width,
    h: canvas.height,
    object: {
      kind: 'interface',
      owner: 'hii',
      status: canvas.entryUrl || ['waymark-location', 'hii-link'].includes(canvas.surface) ? 'ready' : 'partial',
      source: `hii-app:${application.id}@${application.version}`,
      capabilityId: application.capabilities[0],
      proofRefs: receiptPath ? [receiptPath] : [],
      audit: [{ ts: now, actor: 'human', action: `launched ${application.name} from ${source}` }]
    },
    payload: {
      surface: canvas.surface,
      title: application.name,
      applicationId: application.id,
      applicationVersion: application.version,
      developer: application.developer,
      summary: application.summary,
      icon: application.icon,
      entryUrl: canvas.entryUrl,
      capabilities: application.capabilities,
      windowState: 'normal',
      launchSource: source,
      launchReceiptPath: receiptPath
    }
  };
}
