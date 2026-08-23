import type { SpacePolicyMode } from '../policy.ts';
import type { SpacePolicy } from '../types.ts';
import type { SpaceEventHub } from './events.ts';
import type { SpaceHostAuthority } from './authority.ts';
import type { SpacePublisher } from '../publication.ts';

export type SpaceUploadLimitUpdate = Partial<Pick<SpacePolicy, 'maxUploadBytes' | 'storageQuotaBytes' | 'maxObjects'>>;

export class SpaceHostControls {
  private readonly events: SpaceEventHub;
  private readonly authority: SpaceHostAuthority;
  private readonly publisher?: SpacePublisher;

  constructor(
    events: SpaceEventHub,
    authority: SpaceHostAuthority,
    publisher?: SpacePublisher
  ) {
    this.events = events;
    this.authority = authority;
    this.publisher = publisher;
  }

  removeObject(spaceId: string, objectId: string) {
    return this.events.removeObject(spaceId, objectId);
  }

  clearSpace(spaceId: string) {
    return this.events.clearSpace(spaceId);
  }

  removeParticipant(spaceId: string, participantId: string) {
    return this.events.revokeParticipant(spaceId, participantId);
  }

  freezeWrites(spaceId: string, frozen = true) {
    return this.events.updatePolicy(spaceId, { writesFrozen: frozen });
  }

  disableUploads(spaceId: string, disabled = true) {
    return this.events.updatePolicy(spaceId, { uploadsEnabled: !disabled });
  }

  configureUploadLimits(spaceId: string, limits: SpaceUploadLimitUpdate) {
    return this.events.updatePolicy(spaceId, limits);
  }

  async setPolicyMode(spaceId: string, mode: SpacePolicyMode) {
    return this.events.setPolicyMode(spaceId, mode);
  }

  async createInvite(spaceId: string, ttlMs?: number) {
    await import('../../server/space-store.ts').then(({ readSpace }) => readSpace(spaceId));
    return this.authority.createInvite(spaceId, ttlMs);
  }

  publishSpace(spaceId: string) {
    if (!this.publisher) throw new Error('Internet publication is not available on this listener.');
    return this.publisher.publish(spaceId);
  }

  unpublishSpace(spaceId: string) {
    if (!this.publisher) throw new Error('Internet publication is not available on this listener.');
    return this.publisher.unpublish(spaceId);
  }
}
