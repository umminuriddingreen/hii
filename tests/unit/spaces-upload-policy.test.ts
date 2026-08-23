import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import {
  inspectAndSanitizeSpaceImage,
  safeSpaceAssetName,
  SlidingWindowUploadLimiter
} from '../../lib/spaces/upload-policy.ts';

function png(width = 2, height = 3, metadata = false) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type: string, data: Buffer) => {
    const value = Buffer.alloc(12 + data.length);
    value.writeUInt32BE(data.length, 0);
    value.write(type, 4, 'ascii');
    data.copy(value, 8);
    value.writeUInt32BE(crc32(value.subarray(4, 8 + data.length)), 8 + data.length);
    return value;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    ...(metadata ? [chunk('tEXt', Buffer.from('GPS=private'))] : []),
    chunk('IDAT', deflateSync(Buffer.alloc(width * height <= 10_000 ? height * (1 + width * 4) : 1))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function crc32(input: Buffer) {
  let crc = 0xffff_ffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function jpegWithExif() {
  const segment = (marker: number, data: Buffer) => {
    const value = Buffer.alloc(4 + data.length);
    value[0] = 0xff;
    value[1] = marker;
    value.writeUInt16BE(data.length + 2, 2);
    data.copy(value, 4);
    return value;
  };
  const sof = Buffer.from([8, 0, 3, 0, 2, 1, 1, 0x11, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe1, Buffer.from('Exif\0\0GPS private')),
    segment(0xc0, sof),
    segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([0, 0xff, 0xd9])
  ]);
}

describe('Space upload policy', () => {
  it('trusts image magic rather than a caller-supplied MIME and strips PNG metadata', () => {
    const result = inspectAndSanitizeSpaceImage(png(2, 3, true), 1024);
    expect(result).toMatchObject({ mime: 'image/png', width: 2, height: 3 });
    expect(result.bytes.toString('latin1')).not.toContain('GPS=private');
    expect(() => inspectAndSanitizeSpaceImage(Buffer.from('<svg><script/></svg>'), 1024)).toThrow(/supported JPEG, PNG, or WebP/);
  });

  it('enforces byte and decode-bomb dimension limits without decoding pixels', () => {
    expect(() => inspectAndSanitizeSpaceImage(png(), 10)).toThrow(/upload limit/);
    expect(() => inspectAndSanitizeSpaceImage(png(12_001, 1), 1024)).toThrow(/dimensions/);
    expect(() => inspectAndSanitizeSpaceImage(png(10_000, 10_000), 1024)).toThrow(/dimensions/);
  });

  it('removes JPEG EXIF/GPS while retaining dimensions and image data', () => {
    const result = inspectAndSanitizeSpaceImage(jpegWithExif(), 1024);
    expect(result).toMatchObject({ mime: 'image/jpeg', width: 2, height: 3 });
    expect(result.bytes.toString('latin1')).not.toContain('Exif');
    expect(result.bytes.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
  });

  it('rejects incomplete JPEGs and corrupt PNG payloads instead of storing arbitrary bytes', () => {
    expect(() => inspectAndSanitizeSpaceImage(jpegWithExif().subarray(0, -2), 1024)).toThrow(/complete image ending/);
    const corrupt = png();
    corrupt[corrupt.length - 1] ^= 1;
    expect(() => inspectAndSanitizeSpaceImage(corrupt, 1024)).toThrow(/checksum/);
  });

  it('mirrors safe asset naming and bounds uploads per peer in a sliding window', () => {
    expect(safeSpaceAssetName('../../client brief.png')).toBe('client_brief.png');
    const limiter = new SlidingWindowUploadLimiter(2, 1_000);
    expect(limiter.take('peer', 0)).toBe(true);
    expect(limiter.take('peer', 1)).toBe(true);
    expect(limiter.take('peer', 2)).toBe(false);
    expect(limiter.take('peer', 1_001)).toBe(true);
  });
});
