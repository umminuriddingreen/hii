import {
  isSpaceId,
  type PublicSpaceObject,
  type PublicSpaceObjectType,
  type PublicSpaceProjection,
  type PublicSpaceResolver
} from './types.ts';

const OBJECT_TYPES = new Set<PublicSpaceObjectType>(['image', 'text', 'sticker', 'drawing']);
const OBJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_OBJECTS = 256;
const MAX_CONTENT_FIELDS = 12;
const MAX_CONTENT_BYTES = 8 * 1024;
const MAX_PROJECTION_BYTES = 512 * 1024;
const encoder = new TextEncoder();

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function safeContent(raw: unknown): PublicSpaceObject['content'] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length > MAX_CONTENT_FIELDS) return null;
  const content: Record<string, string | number | boolean | readonly number[]> = {};
  let contentBytes = 0;
  for (const [key, value] of entries) {
    if (!/^[a-z][A-Za-z0-9]{0,31}$/.test(key)) return null;
    if (typeof value === 'string') {
      if (value.length > 4_096) return null;
      contentBytes += encoder.encode(key).byteLength + encoder.encode(value).byteLength;
      content[key] = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      contentBytes += encoder.encode(key).byteLength + 8;
      content[key] = value;
    } else if (typeof value === 'boolean') {
      contentBytes += encoder.encode(key).byteLength + 1;
      content[key] = value;
    } else if (
      Array.isArray(value) &&
      value.length <= 1_024 &&
      value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
    ) {
      contentBytes += encoder.encode(key).byteLength + value.length * 8;
      content[key] = Object.freeze([...value]);
    } else {
      return null;
    }
    if (contentBytes > MAX_CONTENT_BYTES) return null;
  }
  return Object.freeze(content);
}

function safeObject(raw: unknown): PublicSpaceObject | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Partial<PublicSpaceObject>;
  if (
    typeof value.id !== 'string' || !OBJECT_ID.test(value.id) ||
    typeof value.type !== 'string' || !OBJECT_TYPES.has(value.type as PublicSpaceObjectType) ||
    !finite(value.x) || !finite(value.y) || !finite(value.width) || !finite(value.height) ||
    value.width < 1 || value.height < 1 || !finite(value.rotation) ||
    typeof value.updatedAt !== 'string'
  ) return null;
  const content = safeContent(value.content);
  if (!content) return null;
  return Object.freeze({
    id: value.id,
    type: value.type as PublicSpaceObjectType,
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
    rotation: value.rotation,
    content,
    updatedAt: value.updatedAt
  });
}

/** Validate at the resolver boundary; callers never receive arbitrary provider fields. */
export function safePublicProjection(raw: unknown): PublicSpaceProjection | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Partial<PublicSpaceProjection>;
  if (
    value.schemaVersion !== 1 ||
    typeof value.id !== 'string' || !isSpaceId(value.id) ||
    typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 120 ||
    !value.policy || value.policy.read !== 'public' ||
    (value.policy.write !== 'local' && value.policy.write !== 'none') ||
    !Array.isArray(value.objects) || value.objects.length > MAX_OBJECTS ||
    typeof value.updatedAt !== 'string'
  ) return null;
  const objects = value.objects.map(safeObject);
  if (objects.some((object) => object === null)) return null;
  const projection: PublicSpaceProjection = Object.freeze({
    schemaVersion: 1,
    id: value.id,
    name: value.name,
    policy: Object.freeze({ read: 'public', write: value.policy.write }),
    objects: Object.freeze(objects as PublicSpaceObject[]),
    updatedAt: value.updatedAt
  });
  if (encoder.encode(JSON.stringify(projection)).byteLength > MAX_PROJECTION_BYTES) return null;
  return projection;
}

export function createFixtureResolver(records: readonly unknown[]): PublicSpaceResolver {
  const projections = new Map<string, PublicSpaceProjection>();
  for (const record of records) {
    const projection = safePublicProjection(record);
    if (!projection) throw new TypeError('Preview fixture contains an unsafe public Space projection.');
    projections.set(projection.id, projection);
  }
  return Object.freeze({
    async resolve(spaceId: string) {
      return projections.get(spaceId) ?? null;
    }
  });
}
