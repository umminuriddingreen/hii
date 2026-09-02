import type { TokenVisual } from './types';

type ProjectedPoint = { x: number; y: number };

const SEMANTIC_ANCHORS: Record<string, ProjectedPoint> = {
  design: { x: 0.18, y: 0.30 },
  create: { x: 0.18, y: 0.30 },
  make: { x: 0.18, y: 0.30 },
  small: { x: 0.30, y: 0.68 },
  compact: { x: 0.30, y: 0.68 },
  concrete: { x: 0.53, y: 0.28 },
  stone: { x: 0.53, y: 0.28 },
  house: { x: 0.66, y: 0.47 },
  home: { x: 0.66, y: 0.47 },
  beside: { x: 0.45, y: 0.77 },
  near: { x: 0.45, y: 0.77 },
  ocean: { x: 0.78, y: 0.74 },
  sea: { x: 0.78, y: 0.74 },
  openings: { x: 0.72, y: 0.34 },
  courtyard: { x: 0.58, y: 0.60 },
  sheltered: { x: 0.48, y: 0.55 },
  broad: { x: 0.73, y: 0.25 },
};

export function stableUnit(value: string, salt = 0): number {
  let hash = 2166136261 ^ salt;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10_000) / 10_000;
}

/** Deterministic prototype layout. It is intentionally not an embedding claim. */
export function projectMockSemantics(tokens: Array<Pick<TokenVisual, 'id' | 'text'>>): ProjectedPoint[] {
  const raw = tokens.map((token, index) => {
    const key = token.text.toLocaleLowerCase().replace(/[^\p{L}\p{N}-]/gu, '');
    const anchor = SEMANTIC_ANCHORS[key];
    if (anchor) {
      return {
        x: clamp(anchor.x + (stableUnit(token.id, 17) - 0.5) * 0.055),
        y: clamp(anchor.y + (stableUnit(token.id, 31) - 0.5) * 0.055),
      };
    }
    const functionWord = /^(a|an|the|and|or|with|that|using|to|of|in|on|for)$/i.test(key);
    const band = functionWord ? 0.48 : 0.18 + stableUnit(key || token.id, 43) * 0.64;
    return {
      x: clamp(0.13 + stableUnit(`${token.id}:${index}`, 59) * 0.68),
      y: clamp(band + (stableUnit(token.id, 71) - 0.5) * 0.12),
    };
  });
  const settled: ProjectedPoint[] = [];
  raw.forEach((point, index) => {
    const options = [point];
    for (let ring = 1; ring <= 3; ring += 1) {
      const radius = ring * 0.055;
      for (let step = 0; step < 8; step += 1) {
        const angle = stableUnit(tokens[index].id, 83) * Math.PI * 2 + (step / 8) * Math.PI * 2;
        options.push({ x: clamp(point.x + Math.cos(angle) * radius), y: clamp(point.y + Math.sin(angle) * radius) });
      }
    }
    const best = options.reduce((winner, candidate) => {
      const clearance = settled.length
        ? Math.min(...settled.map((other) => Math.hypot((candidate.x - other.x) * 0.78, candidate.y - other.y)))
        : 1;
      const winnerClearance = settled.length
        ? Math.min(...settled.map((other) => Math.hypot((winner.x - other.x) * 0.78, winner.y - other.y)))
        : 1;
      const score = clearance - Math.hypot(candidate.x - point.x, candidate.y - point.y) * 0.28;
      const winnerScore = winnerClearance - Math.hypot(winner.x - point.x, winner.y - point.y) * 0.28;
      return score > winnerScore ? candidate : winner;
    }, point);
    settled.push(best);
  });
  return settled;
}

/**
 * Projects compatible embeddings onto two principal axes with power iteration.
 * The mocked layout above remains a separate fallback by design.
 */
export function projectEmbeddingsWithPca(embeddings: number[][]): ProjectedPoint[] | null {
  if (embeddings.length < 3) return null;
  const dimensions = embeddings[0]?.length || 0;
  if (dimensions < 2 || embeddings.some((embedding) => embedding.length !== dimensions)) return null;

  const means = Array.from({ length: dimensions }, (_, dimension) =>
    embeddings.reduce((sum, embedding) => sum + embedding[dimension], 0) / embeddings.length,
  );
  const centered = embeddings.map((embedding) => embedding.map((value, dimension) => value - means[dimension]));
  const multiplyCovariance = (vector: number[]) => {
    const output = Array(dimensions).fill(0) as number[];
    for (const row of centered) {
      const dot = row.reduce((sum, value, dimension) => sum + value * vector[dimension], 0);
      for (let dimension = 0; dimension < dimensions; dimension += 1) output[dimension] += row[dimension] * dot;
    }
    return output;
  };
  const normalize = (vector: number[]) => {
    const magnitude = Math.hypot(...vector);
    return magnitude > 1e-9 ? vector.map((value) => value / magnitude) : null;
  };
  const component = (seed: number[], orthogonal?: number[]) => {
    let vector = normalize(seed) || Array(dimensions).fill(1 / Math.sqrt(dimensions));
    for (let iteration = 0; iteration < 36; iteration += 1) {
      let next = multiplyCovariance(vector);
      if (orthogonal) {
        const dot = next.reduce((sum, value, dimension) => sum + value * orthogonal[dimension], 0);
        next = next.map((value, dimension) => value - dot * orthogonal[dimension]);
      }
      const normalized = normalize(next);
      if (!normalized) return null;
      vector = normalized;
    }
    return vector;
  };

  const first = component(Array.from({ length: dimensions }, (_, index) => 1 + (index % 7) * 0.07));
  if (!first) return null;
  const second = component(Array.from({ length: dimensions }, (_, index) => (index % 2 ? -1 : 1) * (1 + index * 0.01)), first);
  if (!second) return null;
  const raw = centered.map((row) => ({
    x: row.reduce((sum, value, dimension) => sum + value * first[dimension], 0),
    y: row.reduce((sum, value, dimension) => sum + value * second[dimension], 0),
  }));
  const xs = raw.map((point) => point.x);
  const ys = raw.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return raw.map((point) => ({
    x: 0.12 + normalizeRange(point.x, minX, maxX) * 0.68,
    y: 0.16 + normalizeRange(point.y, minY, maxY) * 0.68,
  }));
}

function normalizeRange(value: number, minimum: number, maximum: number) {
  return maximum - minimum < 1e-9 ? 0.5 : (value - minimum) / (maximum - minimum);
}

function clamp(value: number) {
  return Math.max(0.08, Math.min(0.88, value));
}
