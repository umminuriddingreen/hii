import { GUEST_DEVICE_ID_PATTERN, GUEST_ID_PATTERN } from './guest.ts';
import { SPACE_PRESENCE_TIMEOUT_MS } from './protocol.ts';
import { isSpaceId } from './types.ts';

export const MAX_PRESENCE_PARTICIPANTS_PER_SPACE = 1_000;

export type ParticipantPresence = {
  spaceId: string;
  participantId: string;
  joinedAt: number;
  lastSeenAt: number;
};

type PresenceRecord = ParticipantPresence & { deviceId: string };

export class ParticipantPresenceError extends Error {
  readonly code: 'invalid_presence' | 'not_present' | 'device_mismatch' | 'capacity_reached';

  constructor(code: ParticipantPresenceError['code'], message: string) {
    super(message);
    this.name = 'ParticipantPresenceError';
    this.code = code;
  }
}

function validateIdentity(spaceId: string, participantId: string, deviceId: string): void {
  if (!isSpaceId(spaceId) || !GUEST_ID_PATTERN.test(participantId) || !GUEST_DEVICE_ID_PATTERN.test(deviceId)) {
    throw new ParticipantPresenceError('invalid_presence', 'Participant presence identity is invalid or exceeds its wire bounds.');
  }
}

function validNow(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new ParticipantPresenceError('invalid_presence', 'Participant presence time must be a non-negative integer.');
  }
  return now;
}

function publicRecord(record: PresenceRecord): ParticipantPresence {
  return {
    spaceId: record.spaceId,
    participantId: record.participantId,
    joinedAt: record.joinedAt,
    lastSeenAt: record.lastSeenAt
  };
}

/** Process-local participant state. This class has no persistence dependency by design. */
export class ParticipantPresenceRegistry {
  readonly timeoutMs: number;
  readonly maxParticipantsPerSpace: number;
  #spaces = new Map<string, Map<string, PresenceRecord>>();

  constructor(options: { timeoutMs?: number; maxParticipantsPerSpace?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? SPACE_PRESENCE_TIMEOUT_MS;
    this.maxParticipantsPerSpace = options.maxParticipantsPerSpace ?? MAX_PRESENCE_PARTICIPANTS_PER_SPACE;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 10 * 60_000
      || !Number.isSafeInteger(this.maxParticipantsPerSpace) || this.maxParticipantsPerSpace < 1
      || this.maxParticipantsPerSpace > MAX_PRESENCE_PARTICIPANTS_PER_SPACE) {
      throw new ParticipantPresenceError('invalid_presence', 'Participant presence bounds are invalid.');
    }
  }

  join(spaceId: string, participantId: string, deviceId: string, now = Date.now()): ParticipantPresence {
    validateIdentity(spaceId, participantId, deviceId);
    const at = validNow(now);
    this.expire(at, spaceId);
    let participants = this.#spaces.get(spaceId);
    if (!participants) {
      participants = new Map();
      this.#spaces.set(spaceId, participants);
    }
    const existing = participants.get(participantId);
    if (existing && existing.deviceId !== deviceId) {
      throw new ParticipantPresenceError('device_mismatch', 'Participant is already bound to another browser device.');
    }
    if (!existing && participants.size >= this.maxParticipantsPerSpace) {
      throw new ParticipantPresenceError('capacity_reached', 'Space participant capacity has been reached.');
    }
    const record: PresenceRecord = existing
      ? { ...existing, lastSeenAt: Math.max(existing.lastSeenAt, at) }
      : { spaceId, participantId, deviceId, joinedAt: at, lastSeenAt: at };
    participants.set(participantId, record);
    return publicRecord(record);
  }

  heartbeat(spaceId: string, participantId: string, deviceId: string, now = Date.now()): ParticipantPresence {
    validateIdentity(spaceId, participantId, deviceId);
    const at = validNow(now);
    this.expire(at, spaceId);
    const record = this.#spaces.get(spaceId)?.get(participantId);
    if (!record) throw new ParticipantPresenceError('not_present', 'Participant must join before sending a heartbeat.');
    if (record.deviceId !== deviceId) throw new ParticipantPresenceError('device_mismatch', 'Heartbeat device does not own this participant session.');
    record.lastSeenAt = Math.max(record.lastSeenAt, at);
    return publicRecord(record);
  }

  leave(spaceId: string, participantId: string, deviceId: string): boolean {
    validateIdentity(spaceId, participantId, deviceId);
    const participants = this.#spaces.get(spaceId);
    const record = participants?.get(participantId);
    if (!record) return false;
    if (record.deviceId !== deviceId) throw new ParticipantPresenceError('device_mismatch', 'Leave device does not own this participant session.');
    participants?.delete(participantId);
    if (participants?.size === 0) this.#spaces.delete(spaceId);
    return true;
  }

  list(spaceId: string, now = Date.now()): ParticipantPresence[] {
    if (!isSpaceId(spaceId)) throw new ParticipantPresenceError('invalid_presence', 'Space id is invalid.');
    this.expire(validNow(now), spaceId);
    return [...(this.#spaces.get(spaceId)?.values() ?? [])]
      .map(publicRecord)
      .sort((a, b) => a.participantId.localeCompare(b.participantId));
  }

  expire(now = Date.now(), onlySpaceId?: string): ParticipantPresence[] {
    const at = validNow(now);
    if (onlySpaceId !== undefined && !isSpaceId(onlySpaceId)) {
      throw new ParticipantPresenceError('invalid_presence', 'Space id is invalid.');
    }
    const expired: ParticipantPresence[] = [];
    const spaces = onlySpaceId ? [[onlySpaceId, this.#spaces.get(onlySpaceId)] as const] : [...this.#spaces.entries()];
    for (const [spaceId, participants] of spaces) {
      if (!participants) continue;
      for (const [participantId, record] of participants) {
        if (at - record.lastSeenAt >= this.timeoutMs) {
          expired.push(publicRecord(record));
          participants.delete(participantId);
        }
      }
      if (participants.size === 0) this.#spaces.delete(spaceId);
    }
    return expired;
  }
}
