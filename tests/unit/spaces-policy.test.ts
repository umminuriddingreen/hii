import { describe, expect, it } from 'vitest';
import {
  SPACE_POLICY_MODES,
  evaluateSpacePolicy,
  spacePolicyForMode,
  spacePolicyMode,
  type SpacePolicyActor,
  type SpacePolicyMode,
  type SpacePolicyOperation
} from '../../lib/spaces/policy';

const audiences = ['local', 'public'] as const;
const actors: SpacePolicyActor[] = ['host', 'guest', 'invite'];
const operations: SpacePolicyOperation[] = ['join', 'read', 'write', 'upload'];

function expected(
  mode: SpacePolicyMode,
  audience: (typeof audiences)[number],
  actor: SpacePolicyActor,
  operation: SpacePolicyOperation
) {
  if (mode === 'INVITE_ONLY' && actor === 'guest') return false;
  if (mode === 'LOCAL_READ_LOCAL_WRITE') return audience === 'local';
  if (mode === 'PUBLIC_READ_LOCAL_WRITE') {
    return operation === 'join' || operation === 'read' ? true : audience === 'local';
  }
  if (mode === 'PUBLIC_READ_ONLY') return operation === 'join' || operation === 'read';
  return true;
}

describe('canonical Space policy modes', () => {
  it('round-trips every mode through canonical Space policy fields', () => {
    for (const mode of SPACE_POLICY_MODES) {
      const policy = spacePolicyForMode(mode);
      expect(spacePolicyMode(policy)).toBe(mode);
    }
  });

  it('does not overload host switches or limits when changing mode', () => {
    const current = {
      ...spacePolicyForMode('LOCAL_READ_LOCAL_WRITE'),
      writesFrozen: true,
      uploadsEnabled: false,
      maxUploadBytes: 12,
      storageQuotaBytes: 34,
      maxObjects: 56
    };
    expect(spacePolicyForMode('PUBLIC_READ_ONLY', current)).toEqual({
      ...current,
      admission: 'open',
      read: 'public',
      write: 'none'
    });
  });

  it('denies unrecognized access-field combinations by refusing to label them', () => {
    expect(
      spacePolicyMode({
        ...spacePolicyForMode('LOCAL_READ_LOCAL_WRITE'),
        admission: 'invite',
        read: 'local'
      })
    ).toBeNull();
  });
});

describe('Space policy decision matrix', () => {
  it('exhaustively evaluates mode x listener audience x actor x operation', () => {
    for (const mode of SPACE_POLICY_MODES) {
      const policy = spacePolicyForMode(mode);
      for (const audience of audiences) {
        for (const actor of actors) {
          for (const operation of operations) {
            const decision = evaluateSpacePolicy(policy, {
              audience,
              actor,
              operation,
              ...(operation === 'upload' ? { uploadBytes: 1, storageUsedBytes: 0 } : {})
            });
            expect(
              decision.allowed,
              `${mode} ${audience} ${actor} ${operation}: ${decision.reason}`
            ).toBe(expected(mode, audience, actor, operation));
          }
        }
      }
    }
  });

  it('returns stable reasons for invite, listener, and read-only denials', () => {
    expect(
      evaluateSpacePolicy(spacePolicyForMode('INVITE_ONLY'), {
        audience: 'local', actor: 'guest', operation: 'join'
      }).reason
    ).toBe('POLICY_INVITE_REQUIRED');
    expect(
      evaluateSpacePolicy(spacePolicyForMode('LOCAL_READ_LOCAL_WRITE'), {
        audience: 'public', actor: 'invite', operation: 'read'
      }).reason
    ).toBe('POLICY_LOCAL_AUDIENCE_REQUIRED');
    expect(
      evaluateSpacePolicy(spacePolicyForMode('PUBLIC_READ_ONLY'), {
        audience: 'public', actor: 'host', operation: 'write'
      }).reason
    ).toBe('POLICY_READ_ONLY');
  });
});

describe('host controls and limits', () => {
  const writable = spacePolicyForMode('PUBLIC_READ_LOCAL_WRITE');

  it('applies freeze and upload switches to permitted actors', () => {
    expect(
      evaluateSpacePolicy({ ...writable, writesFrozen: true }, {
        audience: 'local', actor: 'host', operation: 'write'
      }).reason
    ).toBe('POLICY_WRITES_FROZEN');
    expect(
      evaluateSpacePolicy({ ...writable, uploadsEnabled: false }, {
        audience: 'local', actor: 'guest', operation: 'upload', uploadBytes: 1,
        storageUsedBytes: 0
      }).reason
    ).toBe('POLICY_UPLOADS_DISABLED');
  });

  it('enforces per-upload and total-storage limits at their exact boundaries', () => {
    const policy = { ...writable, maxUploadBytes: 10, storageQuotaBytes: 20 };
    expect(evaluateSpacePolicy(policy, {
      audience: 'local', actor: 'guest', operation: 'upload', uploadBytes: 10,
      storageUsedBytes: 10
    }).allowed).toBe(true);
    expect(evaluateSpacePolicy(policy, {
      audience: 'local', actor: 'guest', operation: 'upload', uploadBytes: 11,
      storageUsedBytes: 0
    }).reason).toBe('POLICY_UPLOAD_TOO_LARGE');
    expect(evaluateSpacePolicy(policy, {
      audience: 'local', actor: 'guest', operation: 'upload', uploadBytes: 10,
      storageUsedBytes: 11
    }).reason).toBe('POLICY_STORAGE_QUOTA_EXCEEDED');
  });

  it('enforces object count only for creates and denies missing counters', () => {
    const policy = { ...writable, maxObjects: 2 };
    expect(evaluateSpacePolicy(policy, {
      audience: 'local', actor: 'guest', operation: 'write', createsObject: true,
      objectCount: 1
    }).allowed).toBe(true);
    expect(evaluateSpacePolicy(policy, {
      audience: 'local', actor: 'guest', operation: 'write', createsObject: true,
      objectCount: 2
    }).reason).toBe('POLICY_OBJECT_LIMIT_REACHED');
    expect(evaluateSpacePolicy(policy, {
      audience: 'local', actor: 'guest', operation: 'write', createsObject: true
    }).reason).toBe('POLICY_OBJECT_COUNT_REQUIRED');
  });

  it('denies malformed policy and request data by default', () => {
    expect(evaluateSpacePolicy({ ...writable, maxObjects: -1 }, {
      audience: 'local', actor: 'guest', operation: 'read'
    }).reason).toBe('POLICY_INVALID');
    expect(evaluateSpacePolicy(writable, {
      audience: 'local', actor: 'guest', operation: 'upload'
    }).reason).toBe('POLICY_UPLOAD_SIZE_REQUIRED');
  });

  it('reevaluates a changed record without cached authority', () => {
    const request = { audience: 'public', actor: 'guest', operation: 'write' } as const;
    expect(evaluateSpacePolicy(spacePolicyForMode('INVITE_ONLY'), request).allowed).toBe(false);
    expect(evaluateSpacePolicy(spacePolicyForMode('PUBLIC_READ_ONLY'), request).allowed).toBe(false);
    expect(evaluateSpacePolicy(spacePolicyForMode('INVITE_ONLY'), {
      ...request, actor: 'invite'
    }).allowed).toBe(true);
  });
});
