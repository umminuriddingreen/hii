import type { Space, SpacePolicy } from './types';
import { isSpaceId, slugifySpaceName } from './types';
import { toString as encodeQrToString } from 'qrcode';

export const HII_PUBLIC_SPACES_ORIGIN = 'https://humaninformationinterface.com';

function requireSpaceId(spaceId: string): string {
  if (!isSpaceId(spaceId)) {
    throw new TypeError('spaceId must be a canonical HII Space id');
  }
  return spaceId;
}

/**
 * Accept only an origin already selected by the HII host or publication layer.
 * In particular, this never derives an origin from an untrusted request Host
 * header. Callers pass one of `RunningSpacesHost.origins` (local/LAN) or the
 * configured HII publication origin (public).
 */
export function trustedSpaceOrigin(rawOrigin: string, publicOnly = false): string {
  let parsed: URL;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    throw new TypeError('A valid trusted Space origin is required');
  }

  const allowedProtocol = publicOnly
    ? parsed.protocol === 'https:'
    : parsed.protocol === 'http:' || parsed.protocol === 'https:';
  if (
    !allowedProtocol ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError('Space origins must be bare HTTP(S) origins without credentials');
  }

  return parsed.origin;
}

export function spaceAccessPath(spaceId: string): string {
  return `/s/${requireSpaceId(spaceId)}`;
}

export function buildLocalSpaceUrl(spaceId: string, trustedHostOrigin: string): string {
  return `${trustedSpaceOrigin(trustedHostOrigin)}${spaceAccessPath(spaceId)}`;
}

export function buildPublishedSpaceUrl(
  spaceId: string,
  trustedPublicOrigin = HII_PUBLIC_SPACES_ORIGIN
): string {
  return `${trustedSpaceOrigin(trustedPublicOrigin, true)}${spaceAccessPath(spaceId)}`;
}

/** QR encoders receive this value verbatim; encoding is never delegated to a service. */
export function spaceQrPayload(exactAccessUrl: string): string {
  const parsed = new URL(exactAccessUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new TypeError('A Space QR payload must be an HTTP(S) access URL');
  }
  return exactAccessUrl;
}

/**
 * Encode a Space link entirely in-process and return an image-safe SVG data URL.
 * The generated SVG is never inserted as HTML; callers render it as an image.
 */
export async function generateOfflineSpaceQrDataUrl(exactAccessUrl: string): Promise<string> {
  const payload = spaceQrPayload(exactAccessUrl);
  const svg = await encodeQrToString(payload, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 320,
    color: { dark: '#10120fff', light: '#ffffffff' }
  });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export type CreateSpaceRequest = {
  id: string;
  ownerId: string;
  name?: string;
  policy?: Partial<SpacePolicy>;
};

export type CreateSpaceCallback = (request: CreateSpaceRequest) => Promise<Space>;

export async function createSpaceFromName(
  name: string,
  ownerId: string,
  onCreate: CreateSpaceCallback
): Promise<Space> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new TypeError('Enter a name for the Space.');
  if (!ownerId) throw new TypeError('A Space owner is required.');
  const id = slugifySpaceName(trimmedName);
  if (!id) {
    throw new TypeError('Use at least one letter or number in the Space name.');
  }
  return onCreate({ id, ownerId, name: trimmedName });
}
