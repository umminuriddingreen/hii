import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { issueGuestCredential } from '../../lib/spaces/guest.ts';
import { ParticipantPresenceError, ParticipantPresenceRegistry } from '../../lib/spaces/participant-presence.ts';

const key = randomBytes(32);

function guest(spaceId = '14th-street') {
  return issueGuestCredential({ spaceId, key, now: 1_000 });
}

function expectPresenceError(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ParticipantPresenceError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ParticipantPresenceError with code ${code}.`);
}

describe('participant presence', () => {
  it('tracks ephemeral join, heartbeat, and leave without exposing the device binding', () => {
    const registry = new ParticipantPresenceRegistry({ timeoutMs: 5_000 });
    const participant = guest();
    expect(registry.join(participant.spaceId, participant.guestId, participant.deviceId, 1_000)).toEqual({
      spaceId: participant.spaceId,
      participantId: participant.guestId,
      joinedAt: 1_000,
      lastSeenAt: 1_000
    });
    expect(registry.heartbeat(participant.spaceId, participant.guestId, participant.deviceId, 2_000).lastSeenAt).toBe(2_000);
    expect(registry.list(participant.spaceId, 2_001)).toHaveLength(1);
    expect(registry.leave(participant.spaceId, participant.guestId, participant.deviceId)).toBe(true);
    expect(registry.list(participant.spaceId, 2_001)).toEqual([]);
  });

  it('expires participants at the timeout and requires a new join', () => {
    const registry = new ParticipantPresenceRegistry({ timeoutMs: 5_000 });
    const participant = guest();
    registry.join(participant.spaceId, participant.guestId, participant.deviceId, 1_000);
    expect(registry.list(participant.spaceId, 5_999)).toHaveLength(1);
    expect(registry.list(participant.spaceId, 6_000)).toEqual([]);
    expectPresenceError(
      () => registry.heartbeat(participant.spaceId, participant.guestId, participant.deviceId, 6_001),
      'not_present'
    );
  });

  it('rejects another device and enforces bounded identity and capacity', () => {
    const registry = new ParticipantPresenceRegistry({ timeoutMs: 5_000, maxParticipantsPerSpace: 1 });
    const first = guest();
    const second = guest();
    registry.join(first.spaceId, first.guestId, first.deviceId, 1_000);
    expect(() => registry.heartbeat(first.spaceId, first.guestId, second.deviceId, 1_001)).toThrow(ParticipantPresenceError);
    expectPresenceError(() => registry.join(second.spaceId, second.guestId, second.deviceId, 1_001), 'capacity_reached');
    expectPresenceError(() => registry.join(first.spaceId, `guest_${'x'.repeat(100)}`, first.deviceId, 1_001), 'invalid_presence');
  });
});
