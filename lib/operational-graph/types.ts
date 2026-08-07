export type OperationalObject = {
  id: string;
  spaceId: string;
  type: string;
  schemaVersion: number;
  properties: Record<string, unknown>;
  provenance: Record<string, unknown>;
  ownerActorId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type OperationalRelation = {
  id: string;
  spaceId: string;
  type: string;
  fromObjectId: string;
  toObjectId: string;
  properties: Record<string, unknown>;
  provenance: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type OperationalOperation = {
  id: string;
  spaceId: string;
  actorId: string;
  deviceId: string | null;
  type: string;
  targetId: string | null;
  baseVersion: number | null;
  lamport: number;
  payload: Record<string, unknown>;
  authorityGrantId: string | null;
  createdAt: string;
};

export type ObjectProjection = {
  spaceId: string;
  objectId: string;
  projection: string;
  state: Record<string, unknown>;
  updatedAt: string;
};

export type OperationalSpaceSnapshot = {
  spaceId: string;
  objects: OperationalObject[];
  relations: OperationalRelation[];
  projections: ObjectProjection[];
  operations: OperationalOperation[];
};
