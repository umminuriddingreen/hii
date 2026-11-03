export const SPACE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

export type PublicSpaceObjectType = 'image' | 'text' | 'sticker' | 'drawing';

export type PublicSpaceObject = Readonly<{
  id: string;
  type: PublicSpaceObjectType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  content: Readonly<Record<string, string | number | boolean | readonly number[]>>;
  updatedAt: string;
}>;

/** Exact remote-readable projection. Owner, guests, grants, provider, and host are absent. */
export type PublicSpaceProjection = Readonly<{
  schemaVersion: 1;
  id: string;
  name: string;
  policy: Readonly<{
    read: 'public';
    write: 'local' | 'none';
  }>;
  objects: readonly PublicSpaceObject[];
  updatedAt: string;
}>;

export interface PublicSpaceResolver {
  resolve(spaceId: string): Promise<PublicSpaceProjection | null>;
}

export function isSpaceId(value: string): boolean {
  return SPACE_ID_PATTERN.test(value);
}
