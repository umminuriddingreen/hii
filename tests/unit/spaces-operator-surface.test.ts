import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HOST_SPACES_API,
  hiiProductRouteFromPathname,
  hostSpaceApiPath,
  hostSpaceControlsApiPath,
  validateSpaceAccessUrl
} from '../../components/spaces/space-surface';

const source = (relative: string) => readFileSync(path.join(import.meta.dirname, '../..', relative), 'utf8');

describe('Spaces operator surface', () => {
  it('keeps Workspace, visitor, and operator routes distinct', () => {
    expect(hiiProductRouteFromPathname('/')).toEqual({ kind: 'workspace' });
    expect(hiiProductRouteFromPathname('/spaces')).toEqual({ kind: 'spaces-home' });
    expect(hiiProductRouteFromPathname('/new')).toEqual({ kind: 'space-new' });
    expect(hiiProductRouteFromPathname('/s/14th-street')).toEqual({ kind: 'space-visitor', spaceId: '14th-street' });
    expect(hiiProductRouteFromPathname('/host/s/14th-street')).toEqual({ kind: 'space-host', spaceId: '14th-street' });
    expect(hiiProductRouteFromPathname('/host/s/../escape')).toEqual({ kind: 'not-found' });
    expect(hiiProductRouteFromPathname('/unknown')).toEqual({ kind: 'not-found' });
  });

  it('uses only the fixed same-origin loopback operator API paths', () => {
    expect(HOST_SPACES_API).toBe('/api/host/spaces');
    expect(hostSpaceApiPath('s1')).toBe('/api/host/spaces/s1');
    expect(hostSpaceControlsApiPath('s1')).toBe('/api/host/spaces/s1/controls');
  });

  it('accepts only a token-free visitor link for the same stable Space id', () => {
    expect(validateSpaceAccessUrl('http://192.168.1.12:4312/s/s1', 's1')).toBe('http://192.168.1.12:4312/s/s1');
    for (const unsafe of [
      'http://user:secret@192.168.1.12:4312/s/s1',
      'http://192.168.1.12:4312/s/other',
      'http://192.168.1.12:4312/s/s1?invite=secret',
      'javascript:alert(1)'
    ]) expect(() => validateSpaceAccessUrl(unsafe, 's1'), unsafe).toThrow(TypeError);
  });

  it('never mounts host controls on the visitor route', () => {
    const entry = source('components/spaces/SpacesHome.tsx');
    expect(entry).toContain("case 'space-host': return <HostSpaceView");
    expect(entry).toContain("case 'space-visitor': return <SpaceCanvas");
    const visitor = source('components/spaces/SpaceCanvas.tsx');
    expect(visitor).not.toContain('HostPanel');
    expect(visitor).not.toContain('/api/host/spaces');
  });

  it('implements the fixed create and control schemas with accessible status output', () => {
    const home = source('components/spaces/SpacesHome.tsx');
    const controls = source('components/spaces/HostPanel.tsx');
    expect(home).toContain("method: 'POST'");
    expect(home).toContain('body: JSON.stringify({ name: request.name })');
    expect(home).not.toContain('JSON.stringify({ id: request.id');
    for (const action of ['set-writes-frozen', 'set-uploads-enabled', 'set-upload-limits', 'set-policy-mode', 'remove-object', 'remove-participant', 'clear-space', 'create-invite']) {
      expect(controls).toContain(action);
    }
    expect(controls).toContain('name="storageQuotaBytes"');
    expect(controls).toContain('name="objectId"');
    expect(controls).toContain('name="participantId"');
    expect(controls).toContain('aria-live="polite"');
    expect(controls).toContain("window.confirm('Clear every object from this Space?')");
  });
});
