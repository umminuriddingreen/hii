import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ecosystemSessionForEnvironment } from '@/components/ecosystem/local-session';
import { buildResourceProjection, type EcosystemResource } from '@/lib/ecosystem/contracts';
import { makeNode, nodeSeedFromResourceProjection } from '@/lib/workspace/ingest';
import { normalizeNode } from '@/lib/workspace/types';

describe('ecosystem canvas integration', () => {
  it('grants only loopback and Tauri an implicit local-owner session', () => {
    expect(ecosystemSessionForEnvironment({ hostname: '127.0.0.1', isTauri: false }).state).toBe('authenticated');
    expect(ecosystemSessionForEnvironment({ hostname: 'localhost', isTauri: false }).state).toBe('authenticated');
    expect(ecosystemSessionForEnvironment({ hostname: 'app.humaninformationinterface.com', isTauri: true }).state).toBe('authenticated');
    expect(ecosystemSessionForEnvironment({ hostname: 'app.humaninformationinterface.com', isTauri: false })).toEqual({ state: 'signed-out' });
    expect(ecosystemSessionForEnvironment({ hostname: 'localhost', isTauri: false })).toMatchObject({
      owner: { displayName: 'Local owner mode' }
    });
  });

  it.each(['file', 'job'] as const)('materializes one reference node with the canonical %s kind', (kind) => {
    const resource: EcosystemResource = {
      id: `${kind}:example`,
      kind,
      name: `Example ${kind}`,
      status: 'ready',
      objectRef: { authority: 'hii-runtime', id: `${kind}:example`, kind }
    };
    const seed = nodeSeedFromResourceProjection(buildResourceProjection(resource));
    const node = makeNode(seed, 40, 80, 2);

    expect(node).toMatchObject({
      type: 'surface',
      x: 40,
      y: 80,
      object: { kind },
      objectRef: { authority: 'hii-runtime', id: `${kind}:example`, kind },
      payload: { resourceId: `${kind}:example`, resourceKind: kind }
    });
    expect(normalizeNode(node)?.object?.kind).toBe(kind);
  });

  it('routes only Workspace through the ecosystem shell and leaves Space routes intact', () => {
    const source = readFileSync('components/spaces/SpacesHome.tsx', 'utf8');
    expect(source).toContain("case 'workspace': return <EcosystemEntry />;");
    expect(source).toContain("case 'spaces-home': return <SpacesHome />;");
    expect(source).toContain("case 'space-host': return <HostSpaceView spaceId={route.spaceId} />;");
    expect(source).toContain("case 'space-visitor': return <SpaceCanvas spaceId={route.spaceId} />;");
  });

  it('links the installable app manifest from root metadata', () => {
    expect(readFileSync('app/layout.tsx', 'utf8')).toContain("manifest: '/manifest.webmanifest'");
  });

  it('does not present local-owner convenience access as a passkey ceremony', () => {
    const entry = readFileSync('components/ecosystem/EcosystemEntry.tsx', 'utf8');
    const shell = readFileSync('components/ecosystem/HiiAppShell.tsx', 'utf8');
    expect(entry).toContain('passkeyAvailable={Boolean(injectedSession)}');
    expect(entry).not.toContain("setSession(localSession)");
    expect(shell).toContain('Passkey sign-in not connected');
  });

  it('holds the product behind a bounded startup check before resolving access', () => {
    const entry = readFileSync('components/ecosystem/EcosystemEntry.tsx', 'utf8');
    const startup = readFileSync('components/ecosystem/HiiStartup.tsx', 'utf8');
    expect(entry).toContain('!sessionReady || !catalogReady');
    expect(entry).toContain('<HiiStartup sessionReady={sessionReady} catalogReady={catalogReady} />');
    expect(startup).toContain('Owner boundary');
    expect(startup).toContain('Local objects');
    expect(startup).toContain('Information surface');
  });
});
