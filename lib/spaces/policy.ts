import {
  defaultSpacePolicy,
  type SpaceAdmission,
  type SpaceAudience,
  type SpacePolicy,
  type SpaceWriteAudience
} from './types.ts';

export const SPACE_POLICY_MODES = [
  'LOCAL_READ_LOCAL_WRITE',
  'PUBLIC_READ_LOCAL_WRITE',
  'PUBLIC_READ_ONLY',
  'INVITE_ONLY'
] as const;

export type SpacePolicyMode = (typeof SPACE_POLICY_MODES)[number];
export type SpacePolicyActor = 'host' | 'guest' | 'invite';
export type SpacePolicyOperation = 'join' | 'read' | 'write' | 'upload';

type AccessFields = Pick<SpacePolicy, 'admission' | 'read' | 'write'>;

const MODE_FIELDS: Record<SpacePolicyMode, AccessFields> = {
  LOCAL_READ_LOCAL_WRITE: { admission: 'open', read: 'local', write: 'local' },
  PUBLIC_READ_LOCAL_WRITE: { admission: 'open', read: 'public', write: 'local' },
  PUBLIC_READ_ONLY: { admission: 'open', read: 'public', write: 'none' },
  INVITE_ONLY: { admission: 'invite', read: 'public', write: 'public' }
};

export type SpacePolicyReasonCode =
  | 'POLICY_ALLOWED'
  | 'POLICY_INVALID'
  | 'POLICY_INVALID_REQUEST'
  | 'POLICY_INVITE_REQUIRED'
  | 'POLICY_LOCAL_AUDIENCE_REQUIRED'
  | 'POLICY_READ_ONLY'
  | 'POLICY_WRITES_FROZEN'
  | 'POLICY_UPLOADS_DISABLED'
  | 'POLICY_UPLOAD_SIZE_REQUIRED'
  | 'POLICY_UPLOAD_TOO_LARGE'
  | 'POLICY_STORAGE_USAGE_REQUIRED'
  | 'POLICY_STORAGE_QUOTA_EXCEEDED'
  | 'POLICY_OBJECT_COUNT_REQUIRED'
  | 'POLICY_OBJECT_LIMIT_REACHED';

export type SpacePolicyDecision = Readonly<{
  allowed: boolean;
  reason: SpacePolicyReasonCode;
}>;

export type SpacePolicyRequest = Readonly<{
  audience: SpaceAudience;
  actor: SpacePolicyActor;
  operation: SpacePolicyOperation;
  /** Required for upload evaluation. */
  uploadBytes?: number;
  /** Required for upload evaluation; durable bytes already retained by this Space. */
  storageUsedBytes?: number;
  /** Set only for an object.create write. */
  createsObject?: boolean;
  /** Required when `createsObject` is true; durable objects before the mutation. */
  objectCount?: number;
}>;

const allow: SpacePolicyDecision = Object.freeze({ allowed: true, reason: 'POLICY_ALLOWED' });
const deny = (reason: Exclude<SpacePolicyReasonCode, 'POLICY_ALLOWED'>): SpacePolicyDecision => ({
  allowed: false,
  reason
});

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validPolicy(policy: SpacePolicy): boolean {
  return (
    (policy.admission === 'open' || policy.admission === 'invite') &&
    (policy.read === 'local' || policy.read === 'public') &&
    (policy.write === 'none' || policy.write === 'local' || policy.write === 'public') &&
    typeof policy.writesFrozen === 'boolean' &&
    typeof policy.uploadsEnabled === 'boolean' &&
    isNonNegativeInteger(policy.maxUploadBytes) &&
    isNonNegativeInteger(policy.storageQuotaBytes) &&
    isNonNegativeInteger(policy.maxObjects)
  );
}

function audienceAllows(required: SpaceAudience | SpaceWriteAudience, actual: SpaceAudience) {
  return required === 'public' || (required === 'local' && actual === 'local');
}

/**
 * Apply a named product mode while retaining independent host controls and limits.
 * The returned fields are what get persisted; the mode itself is never a second authority.
 */
export function spacePolicyForMode(
  mode: SpacePolicyMode,
  current: SpacePolicy = defaultSpacePolicy()
): SpacePolicy {
  return { ...current, ...MODE_FIELDS[mode] };
}

/** Returns the product label represented by the canonical access fields, if any. */
export function spacePolicyMode(policy: SpacePolicy): SpacePolicyMode | null {
  return (
    SPACE_POLICY_MODES.find((mode) => {
      const fields = MODE_FIELDS[mode];
      return (
        policy.admission === fields.admission &&
        policy.read === fields.read &&
        policy.write === fields.write
      );
    }) ?? null
  );
}

/**
 * Evaluate the latest Space record for one participant-surface operation.
 *
 * `audience` identifies the listener that accepted the connection. `local`
 * means the selected LAN listener, not an IP-address inference, geolocation,
 * physical-presence claim, or attestation. Callers should read the Space record
 * again when it changes and invoke this pure function; no decision is cached.
 */
export function evaluateSpacePolicy(
  policy: SpacePolicy,
  request: SpacePolicyRequest
): SpacePolicyDecision {
  if (!validPolicy(policy)) return deny('POLICY_INVALID');
  if (
    (request.audience !== 'local' && request.audience !== 'public') ||
    !['host', 'guest', 'invite'].includes(request.actor) ||
    !['join', 'read', 'write', 'upload'].includes(request.operation)
  ) {
    return deny('POLICY_INVALID_REQUEST');
  }

  if (policy.admission === 'invite' && request.actor !== 'host' && request.actor !== 'invite') {
    return deny('POLICY_INVITE_REQUIRED');
  }
  if (!audienceAllows(policy.read, request.audience)) {
    return deny('POLICY_LOCAL_AUDIENCE_REQUIRED');
  }
  if (request.operation === 'join' || request.operation === 'read') return allow;

  if (policy.write === 'none') return deny('POLICY_READ_ONLY');
  if (!audienceAllows(policy.write, request.audience)) {
    return deny('POLICY_LOCAL_AUDIENCE_REQUIRED');
  }
  if (policy.writesFrozen) return deny('POLICY_WRITES_FROZEN');

  if (request.operation === 'write') {
    if (!request.createsObject) return allow;
    if (!isNonNegativeInteger(request.objectCount)) return deny('POLICY_OBJECT_COUNT_REQUIRED');
    return request.objectCount >= policy.maxObjects
      ? deny('POLICY_OBJECT_LIMIT_REACHED')
      : allow;
  }

  if (!policy.uploadsEnabled) return deny('POLICY_UPLOADS_DISABLED');
  if (!isNonNegativeInteger(request.uploadBytes)) return deny('POLICY_UPLOAD_SIZE_REQUIRED');
  if (request.uploadBytes > policy.maxUploadBytes) return deny('POLICY_UPLOAD_TOO_LARGE');
  if (!isNonNegativeInteger(request.storageUsedBytes)) return deny('POLICY_STORAGE_USAGE_REQUIRED');
  if (request.storageUsedBytes + request.uploadBytes > policy.storageQuotaBytes) {
    return deny('POLICY_STORAGE_QUOTA_EXCEEDED');
  }
  return allow;
}

export type { SpaceAdmission };
