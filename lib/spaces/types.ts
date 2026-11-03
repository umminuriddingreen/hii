/**
 * The Space record: identity, ownership, policy, and hosting state.
 *
 * A Space is not its canvas. The canvas objects for space `s` live in the
 * workspace document at `~/.hii/workspace/workspaces/s.json` and its blobs in
 * `~/.hii/workspace/assets/s/`. This record holds only what that document has
 * no field for and no business owning: who the Space belongs to, who may read
 * and write it, whether it is currently reachable from the internet, and what
 * it is called. Splitting it this way is what keeps a single fact in a single
 * place — see docs/SPACES_ARCHITECTURE.md §6.
 *
 * The Space id and the workspace id are the same string, deliberately. That is
 * what makes the existing durable canvas store the Space store with no
 * migration and no adapter, and it is why the id must satisfy the workspace
 * id rules as well as being safe in a URL path segment.
 */

/**
 * Deliberately identical to `validateWorkspaceId`'s pattern in
 * `lib/server/workspace-store.ts`: a Space id must always be a legal workspace
 * id, because it names that Space's canvas file. `tests/unit/space-store.test.ts`
 * asserts the two stay in agreement rather than trusting this comment.
 *
 * The character set is also the intersection of "safe as a path component" and
 * "safe unencoded in a URL path segment", so `/s/<id>` never needs escaping and
 * `<id>` can never traverse out of the spaces directory.
 */
export const SPACE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

/** Where the authoritative copy of a Space is served from. */
export type SpaceHostingMode =
  /** Reachable only from the machine hosting it and its local network. */
  | 'local-only'
  /** Also reachable from the internet through the current publication. */
  | 'published';

/**
 * Who may read, and who may write.
 *
 * "local" means the request arrived on a local-network listener rather than
 * through the publication tunnel. That is the only distinction the host can
 * actually observe, and it is a network-membership claim — never a claim about
 * where a person physically is. Any interface built on this must say
 * "on this Wi-Fi network", not "here".
 */
export type SpaceAudience = 'local' | 'public';

/** Whether reaching the Space is sufficient to join, or an invite is required. */
export type SpaceAdmission = 'open' | 'invite';

/** `none` makes the participant surface read-only without overloading a freeze. */
export type SpaceWriteAudience = SpaceAudience | 'none';

export type SpacePolicy = {
  /** Admission is independent of addressability: a public Space may still require an invite. */
  admission: SpaceAdmission;
  /** Who may load the Space and its objects. */
  read: SpaceAudience;
  /** Who may create, move, edit, or delete objects. */
  write: SpaceWriteAudience;
  /** Host kill switch. When false, every write is refused regardless of `write`. */
  writesFrozen: boolean;
  /** Whether participants may upload blobs at all. */
  uploadsEnabled: boolean;
  /**
   * Per-file upload ceiling in bytes.
   *
   * The desktop asset path allows 250 MB because it only ever accepted files
   * from the machine's own owner. A Space may accept files from anyone who can
   * reach it, so the default here is three orders of magnitude smaller.
   */
  maxUploadBytes: number;
  /** Total blob bytes a Space may retain. */
  storageQuotaBytes: number;
  /** Ceiling on objects, so one participant cannot exhaust the canvas. */
  maxObjects: number;
};

/** Publication is provider state. This is HII's record *of* it. */
export type SpacePublicationState = 'unpublished' | 'published' | 'failed';

export type SpacePublication = {
  state: SpacePublicationState;
  /**
   * The public URL the Space is currently reachable at, if any.
   *
   * Recorded, never derived from, the Space id: the id must outlive any
   * particular provider, so no provider identifier is ever embedded in it.
   */
  endpoint?: string;
  /** Which mechanism produced `endpoint`, for diagnostics and teardown. */
  provider?: string;
  /** Why the last publish attempt failed, when `state` is 'failed'. */
  error?: string;
  updatedAt: string;
};

export type Space = {
  schemaVersion: 1;
  id: string;
  /** Human-facing name. Free text; never used to address the Space. */
  name: string;
  /** The operator who owns this Space. Guests are never owners. */
  ownerId: string;
  policy: SpacePolicy;
  hosting: SpaceHostingMode;
  publication: SpacePublication;
  createdAt: string;
  updatedAt: string;
  /**
   * Bumped on every accepted write, so a caller holding a stale record is
   * refused rather than having its decision applied to state it never saw.
   * The same optimistic-concurrency rule the workspace document uses.
   */
  revision: number;
};

export type SpaceSummary = {
  id: string;
  name: string;
  ownerId: string;
  hosting: SpaceHostingMode;
  publicationState: SpacePublicationState;
  status: 'ready' | 'recovery';
  updatedAt?: string;
};

/**
 * A new Space is the most restrictive thing it can be: readable and writable
 * only from the local network, unpublished, with uploads on but bounded. A
 * Space becomes more open because someone chose that, never by default.
 */
export function defaultSpacePolicy(): SpacePolicy {
  return {
    admission: 'open',
    read: 'local',
    write: 'local',
    writesFrozen: false,
    uploadsEnabled: true,
    maxUploadBytes: 25 * 1024 * 1024,
    storageQuotaBytes: 2 * 1024 * 1024 * 1024,
    maxObjects: 2_000
  };
}

export function isSpaceId(value: unknown): value is string {
  return typeof value === 'string' && SPACE_ID_PATTERN.test(value);
}

/**
 * Turn a human name into a candidate id.
 *
 * Separated from validation on purpose: this is a convenience for the create
 * flow, and its output is validated like any other input. "14th Street" becomes
 * "14th-street". A name that reduces to nothing (emoji, CJK, punctuation) is
 * not an error here — the caller supplies a fallback id rather than this
 * function inventing one, so that id generation stays in one place.
 */
export function slugifySpaceName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}
