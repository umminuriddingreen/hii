export type PerceptualImageReference = {
  sha256: string;
  perceptualHash?: string;
};

export type PerceptualCandidatePair = {
  id: string;
  sha256s: [string, string];
  distance: number;
};

export type PerceptualReviewDecision = 'separate' | 'stacked';
export type PerceptualReviewDecisions = Record<string, PerceptualReviewDecision>;

const HASH_PATTERN = /^[a-f0-9]{16}$/i;
const SHA_PATTERN = /^[a-f0-9]{64}$/i;

function grayscale(data: Uint8ClampedArray, width: number, height: number, x: number, y: number) {
  const sourceX = Math.min(width - 1, Math.max(0, Math.floor((x + 0.5) * width / 9)));
  const sourceY = Math.min(height - 1, Math.max(0, Math.floor((y + 0.5) * height / 8)));
  const offset = (sourceY * width + sourceX) * 4;
  return Math.round(data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114);
}

export function differenceHashFromRgba(data: Uint8ClampedArray, width: number, height: number) {
  if (width < 1 || height < 1 || data.length < width * height * 4) return '';
  let bits = 0n;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      bits = (bits << 1n) | (grayscale(data, width, height, x, y) > grayscale(data, width, height, x + 1, y) ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

export async function perceptualHashForImage(file: Blob) {
  if (typeof createImageBitmap !== 'function') return '';
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    let context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
    if (typeof OffscreenCanvas === 'function') {
      context = new OffscreenCanvas(9, 8).getContext('2d', { willReadFrequently: true });
    } else if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = 9;
      canvas.height = 8;
      context = canvas.getContext('2d', { willReadFrequently: true });
    }
    if (!context) return '';
    context.drawImage(bitmap, 0, 0, 9, 8);
    return differenceHashFromRgba(context.getImageData(0, 0, 9, 8).data, 9, 8);
  } catch {
    return '';
  } finally {
    bitmap?.close();
  }
}

export function perceptualHashDistance(left: unknown, right: unknown) {
  const a = String(left ?? '').toLowerCase();
  const b = String(right ?? '').toLowerCase();
  if (!HASH_PATTERN.test(a) || !HASH_PATTERN.test(b)) return null;
  let different = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let distance = 0;
  while (different) {
    distance += Number(different & 1n);
    different >>= 1n;
  }
  return distance;
}

export function perceptualCandidatePairs(value: unknown, maxDistance = 6): PerceptualCandidatePair[] {
  const source = Array.isArray(value) ? value : [];
  const references: Array<{sha256:string;perceptualHash:string}> = [];
  const seen = new Set<string>();
  for (const raw of source) {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const sha256 = String(item.sha256 ?? '').toLowerCase();
    const perceptualHash = String(item.perceptualHash ?? '').toLowerCase();
    if (!SHA_PATTERN.test(sha256) || !HASH_PATTERN.test(perceptualHash) || seen.has(sha256)) continue;
    seen.add(sha256);
    references.push({ sha256, perceptualHash });
    if (references.length >= 80) break;
  }
  const threshold = Math.min(16, Math.max(0, Math.floor(Number(maxDistance) || 0)));
  const pairs: PerceptualCandidatePair[] = [];
  for (let left = 0; left < references.length; left += 1) {
    for (let right = left + 1; right < references.length; right += 1) {
      const distance = perceptualHashDistance(references[left].perceptualHash, references[right].perceptualHash);
      if (distance === null || distance > threshold) continue;
      const sha256s: [string, string] = [references[left].sha256, references[right].sha256];
      pairs.push({
        id: `near:${sha256s[0]}:${sha256s[1]}`,
        sha256s,
        distance
      });
    }
  }
  return pairs
    .sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id))
    .slice(0, 24);
}

export function normalizePerceptualReviews(
  candidatesValue: unknown,
  reviewsValue: unknown
): PerceptualReviewDecisions {
  const candidates = Array.isArray(candidatesValue) ? candidatesValue as PerceptualCandidatePair[] : [];
  const ids = new Set(candidates.map((candidate) => candidate.id));
  if (!reviewsValue || typeof reviewsValue !== 'object' || Array.isArray(reviewsValue)) return {};
  return Object.fromEntries(Object.entries(reviewsValue as Record<string, unknown>)
    .filter(([id, decision]) => ids.has(id) && (decision === 'separate' || decision === 'stacked'))
    .slice(0, 24)) as PerceptualReviewDecisions;
}
