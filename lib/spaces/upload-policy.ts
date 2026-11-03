import { inflateSync } from 'node:zlib';

const JPEG_MIME = 'image/jpeg';
const PNG_MIME = 'image/png';
const WEBP_MIME = 'image/webp';

export const SPACE_UPLOAD_LIMITS = Object.freeze({
  hardMaxBytes: 25 * 1024 * 1024,
  maxWidth: 12_000,
  maxHeight: 12_000,
  maxPixels: 40_000_000,
  multipartOverheadBytes: 64 * 1024,
  multipartHeaderBytes: 8 * 1024
});

export type SpaceImage = {
  bytes: Buffer;
  mime: typeof JPEG_MIME | typeof PNG_MIME | typeof WEBP_MIME;
  extension: 'jpg' | 'png' | 'webp';
  width: number;
  height: number;
};

export class SpaceUploadError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'SpaceUploadError';
    this.code = code;
    this.status = status;
  }
}

function invalid(message = 'The upload is not a supported JPEG, PNG, or WebP image.'): never {
  throw new SpaceUploadError('INVALID_IMAGE', message, 415);
}

function enforceDimensions(width: number, height: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  ) invalid('The image has invalid dimensions.');
  if (
    width > SPACE_UPLOAD_LIMITS.maxWidth ||
    height > SPACE_UPLOAD_LIMITS.maxHeight ||
    width * height > SPACE_UPLOAD_LIMITS.maxPixels
  ) {
    throw new SpaceUploadError(
      'IMAGE_DIMENSIONS_EXCEEDED',
      'The image dimensions exceed this Space upload limit.',
      413
    );
  }
}

function inspectPng(input: Buffer): SpaceImage {
  if (input.length < 33 || !input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    invalid();
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawIdat = false;
  let sawEnd = false;
  let bitDepth = 0;
  let colorType = 0;
  const compressed: Buffer[] = [];
  const chunks: Buffer[] = [input.subarray(0, 8)];
  const retainedAncillary = new Set(['cHRM', 'gAMA', 'iCCP', 'sRGB', 'tRNS']);
  while (offset + 12 <= input.length) {
    const length = input.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > input.length) invalid('The PNG is truncated.');
    const type = input.toString('ascii', offset + 4, offset + 8);
    const expectedCrc = input.readUInt32BE(end - 4);
    if (crc32(input.subarray(offset + 4, end - 4)) !== expectedCrc) invalid('The PNG checksum is invalid.');
    if (offset === 8 && (type !== 'IHDR' || length !== 13)) invalid('The PNG header is invalid.');
    if (type === 'IHDR') {
      width = input.readUInt32BE(offset + 8);
      height = input.readUInt32BE(offset + 12);
      bitDepth = input[offset + 16];
      colorType = input[offset + 17];
      if (input[offset + 18] !== 0 || input[offset + 19] !== 0 || input[offset + 20] !== 0) {
        invalid('The PNG encoding is unsupported.');
      }
    }
    if (type === 'IDAT') {
      sawIdat = true;
      compressed.push(input.subarray(offset + 8, end - 4));
    }
    const critical = (input[offset + 4] & 0x20) === 0;
    if (critical || retainedAncillary.has(type)) chunks.push(input.subarray(offset, end));
    offset = end;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (!sawIdat || !sawEnd || offset !== input.length) invalid('The PNG structure is invalid.');
  enforceDimensions(width, height);
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  const validDepths = ({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] } as Record<number, number[]>)[colorType];
  if (!channels || !validDepths?.includes(bitDepth)) invalid('The PNG color format is invalid.');
  const inflatedBytes = height * (1 + Math.ceil((width * channels * bitDepth) / 8));
  try {
    const pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: inflatedBytes + 1 });
    if (pixels.length !== inflatedBytes) invalid('The PNG pixel data is invalid.');
  } catch (error) {
    if (error instanceof SpaceUploadError) throw error;
    invalid('The PNG pixel data is invalid.');
  }
  return { bytes: Buffer.concat(chunks), mime: PNG_MIME, extension: 'png', width, height };
}

function crc32(input: Buffer) {
  let crc = 0xffff_ffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function inspectJpeg(input: Buffer): SpaceImage {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) invalid();
  if (input[input.length - 2] !== 0xff || input[input.length - 1] !== 0xd9) {
    invalid('The JPEG does not have a complete image ending.');
  }
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawScan = false;
  const parts: Buffer[] = [input.subarray(0, 2)];
  while (offset < input.length) {
    const markerStart = offset;
    if (input[offset++] !== 0xff) invalid('The JPEG marker stream is invalid.');
    while (input[offset] === 0xff) offset += 1;
    if (offset >= input.length) invalid('The JPEG is truncated.');
    const marker = input[offset++];
    if (marker === 0xda) {
      if (offset + 2 > input.length) invalid('The JPEG scan is truncated.');
      const length = input.readUInt16BE(offset);
      if (length < 2 || offset + length > input.length) invalid('The JPEG scan is truncated.');
      parts.push(input.subarray(markerStart));
      sawScan = true;
      break;
    }
    if (marker === 0xd9) {
      parts.push(input.subarray(markerStart, offset));
      break;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      parts.push(input.subarray(markerStart, offset));
      continue;
    }
    if (offset + 2 > input.length) invalid('The JPEG is truncated.');
    const length = input.readUInt16BE(offset);
    const end = offset + length;
    if (length < 2 || end > input.length) invalid('The JPEG segment is truncated.');
    if (JPEG_SOF.has(marker)) {
      if (length < 7) invalid('The JPEG dimensions are missing.');
      height = input.readUInt16BE(offset + 3);
      width = input.readUInt16BE(offset + 5);
    }
    // APP1 contains EXIF/GPS or XMP, APP13 carries IPTC, and COM is arbitrary text.
    if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe) {
      parts.push(input.subarray(markerStart, end));
    }
    offset = end;
  }
  if (!sawScan || !width || !height) invalid('The JPEG structure is incomplete.');
  enforceDimensions(width, height);
  return { bytes: Buffer.concat(parts), mime: JPEG_MIME, extension: 'jpg', width, height };
}

function webpDimensions(type: string, payload: Buffer): { width: number; height: number } {
  if (type === 'VP8X' && payload.length >= 10) {
    return {
      width: 1 + payload.readUIntLE(4, 3),
      height: 1 + payload.readUIntLE(7, 3)
    };
  }
  if (type === 'VP8L' && payload.length >= 5 && payload[0] === 0x2f) {
    const bits = payload.readUInt32LE(1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (type === 'VP8 ' && payload.length >= 10 && payload.subarray(3, 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
    return { width: payload.readUInt16LE(6) & 0x3fff, height: payload.readUInt16LE(8) & 0x3fff };
  }
  invalid('The WebP dimensions are missing.');
}

function inspectWebp(input: Buffer): SpaceImage {
  if (
    input.length < 20 ||
    input.toString('ascii', 0, 4) !== 'RIFF' ||
    input.toString('ascii', 8, 12) !== 'WEBP' ||
    input.readUInt32LE(4) + 8 !== input.length
  ) invalid();
  let offset = 12;
  let dimensions: { width: number; height: number } | null = null;
  let sawImageChunk = false;
  const chunks: Buffer[] = [];
  while (offset + 8 <= input.length) {
    const type = input.toString('ascii', offset, offset + 4);
    const length = input.readUInt32LE(offset + 4);
    const end = offset + 8 + length + (length & 1);
    if (end > input.length) invalid('The WebP is truncated.');
    const payload = input.subarray(offset + 8, offset + 8 + length);
    if (!dimensions && (type === 'VP8X' || type === 'VP8L' || type === 'VP8 ')) {
      dimensions = webpDimensions(type, payload);
    }
    if (type === 'VP8L' || type === 'VP8 ') {
      webpDimensions(type, payload);
      sawImageChunk = true;
    }
    if (type !== 'EXIF' && type !== 'XMP ') {
      if (type === 'VP8X') {
        const cleaned = Buffer.from(input.subarray(offset, end));
        cleaned[8] &= ~(0x08 | 0x04);
        chunks.push(cleaned);
      } else chunks.push(input.subarray(offset, end));
    }
    offset = end;
  }
  if (offset !== input.length || !dimensions || !sawImageChunk) invalid('The WebP structure is invalid.');
  enforceDimensions(dimensions.width, dimensions.height);
  const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return {
    bytes: Buffer.concat([header, body]),
    mime: WEBP_MIME,
    extension: 'webp',
    ...dimensions
  };
}

export function inspectAndSanitizeSpaceImage(input: Buffer, policyMaxBytes: number): SpaceImage {
  const maxBytes = Math.min(
    SPACE_UPLOAD_LIMITS.hardMaxBytes,
    Number.isFinite(policyMaxBytes) ? Math.max(0, Math.floor(policyMaxBytes)) : 0
  );
  if (input.length === 0) {
    throw new SpaceUploadError('EMPTY_UPLOAD', 'Choose a non-empty image to upload.', 400);
  }
  if (input.length > maxBytes) {
    throw new SpaceUploadError('UPLOAD_TOO_LARGE', 'The image exceeds this Space upload limit.', 413);
  }
  if (input[0] === 0xff && input[1] === 0xd8) return inspectJpeg(input);
  if (input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return inspectPng(input);
  if (input.toString('ascii', 0, 4) === 'RIFF' && input.toString('ascii', 8, 12) === 'WEBP') return inspectWebp(input);
  invalid();
}

/** Mirrors the shipping Tauri sanitizer, but the stored filename is generated separately. */
export function safeSpaceAssetName(name: string): string {
  const cleaned = Array.from(name)
    .map((character) => (/^[A-Za-z0-9._-]$/.test(character) ? character : '_'))
    .join('')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 160);
  return cleaned || 'asset';
}

export class SlidingWindowUploadLimiter {
  private readonly attempts = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit = 8, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  take(peer: string, now = Date.now()): boolean {
    const recent = (this.attempts.get(peer) ?? []).filter((time) => now - time < this.windowMs);
    if (recent.length >= this.limit) {
      this.attempts.set(peer, recent);
      return false;
    }
    recent.push(now);
    this.attempts.set(peer, recent);
    return true;
  }
}
