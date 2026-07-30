import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  differenceHashFromRgba,
  normalizePerceptualReviews,
  perceptualCandidatePairs,
  perceptualHashDistance,
  perceptualHashForImage
} from '../../lib/workspace/image-similarity';

afterEach(() => vi.unstubAllGlobals());

function horizontalPixels(descending = false) {
  const data = new Uint8ClampedArray(9 * 8 * 4);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 9; x += 1) {
      const value = descending ? 255 - x * 20 : x * 20;
      const offset = (y * 9 + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return data;
}

describe('local image similarity review signals', () => {
  it('creates deterministic 64-bit difference hashes from decoded pixels', () => {
    expect(differenceHashFromRgba(horizontalPixels(false), 9, 8)).toBe('0000000000000000');
    expect(differenceHashFromRgba(horizontalPixels(true), 9, 8)).toBe('ffffffffffffffff');
    expect(perceptualHashDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(perceptualHashDistance('0000000000000000', '0000000000000001')).toBe(1);
    expect(perceptualHashDistance('invalid', '0000000000000001')).toBeNull();
  });

  it('decodes the local image without a network service and closes the bitmap', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close })));
    vi.stubGlobal('OffscreenCanvas', class {
      getContext() {
        return {
          drawImage: vi.fn(),
          getImageData: () => ({ data: horizontalPixels(true) })
        };
      }
    });

    await expect(perceptualHashForImage(new Blob(['local pixels']))).resolves.toBe('ffffffffffffffff');
    expect(close).toHaveBeenCalledOnce();
  });

  it('returns bounded exact candidate pairs and only known human review decisions', () => {
    const first = '1'.padStart(64, '0');
    const second = '2'.padStart(64, '0');
    const far = '3'.padStart(64, '0');
    const candidates = perceptualCandidatePairs([
      { sha256: first, perceptualHash: '0000000000000000' },
      { sha256: second, perceptualHash: '0000000000000001' },
      { sha256: far, perceptualHash: 'ffffffffffffffff' },
      { sha256: second, perceptualHash: '0000000000000000' },
      { sha256: 'invalid', perceptualHash: '0000000000000000' }
    ], 1);

    expect(candidates).toEqual([{
      id: `near:${first}:${second}`,
      sha256s: [first, second],
      distance: 1
    }]);
    expect(normalizePerceptualReviews(candidates, {
      [candidates[0].id]: 'separate',
      unknown: 'stacked',
      malformed: 'delete'
    })).toEqual({ [candidates[0].id]: 'separate' });
  });
});
