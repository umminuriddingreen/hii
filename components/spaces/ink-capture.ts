import { simplifyStroke, strokeBounds, translateStrokes, type InkStroke } from '@/lib/workspace/ink';
import { seedFor, type NodeSeed } from '@/lib/workspace/ingest';

export function inkSeedFromPoints(points: number[]): { seed: NodeSeed; at: { x: number; y: number } } | null {
  const simplified = simplifyStroke(points);
  if (simplified.length < 4) return null;
  const stroke: InkStroke = { points: simplified, color: '#171717', width: 3 };
  const bounds = strokeBounds([stroke]);
  if (!bounds) return null;
  const strokes = translateStrokes([stroke], -bounds.x, -bounds.y);
  return {
    seed: { ...seedFor('ink', { strokes, name: 'Drawing' }), w: Math.max(40, bounds.w), h: Math.max(40, bounds.h) },
    at: { x: bounds.x, y: bounds.y }
  };
}
