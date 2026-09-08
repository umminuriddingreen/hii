import { describe, expect, it } from 'vitest';
import { resolveAccountWorkspaceSelection } from '@/lib/desktop/account-selection';

const own = { id: 'own', role: 'owner' };
const shared = { id: 'shared', role: 'editor' };
const selection = { deviceId: 'device', workspaceId: null, configured: false };

describe('account canvas selection', () => {
  it('opens an owned account workspace on first connection', () => {
    expect(resolveAccountWorkspaceSelection(selection, [shared, own])).toBe('own');
  });
  it('preserves an explicit device-local canvas preference', () => {
    expect(resolveAccountWorkspaceSelection({ ...selection, configured: true }, [own])).toBe('local');
  });
  it('restores the selected canvas even when ordering changes', () => {
    expect(resolveAccountWorkspaceSelection({ ...selection, configured: true, workspaceId: 'shared' }, [own, shared])).toBe('shared');
  });
  it('does not silently substitute an empty canvas when access is lost', () => {
    expect(() => resolveAccountWorkspaceSelection({ ...selection, configured: true, workspaceId: 'lost' }, [own])).toThrow('unavailable');
  });
});
