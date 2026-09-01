import type { NodeSeed } from './ingest';

export type PlacementPoint = { x: number; y: number };

/**
 * Packs a batch around the drop point without overlap. Rows are centered so a
 * multi-file import lands as one legible composition instead of growing away
 * from the cursor.
 */
export function flowSeedPlacements(
  seeds: NodeSeed[],
  anchor: PlacementPoint,
  maxRowWidth = 2_000,
  gap = 40
): PlacementPoint[] {
  if (!seeds.length) return [];

  const rows: Array<{ seeds: NodeSeed[]; width: number; height: number }> = [];
  for (const seed of seeds) {
    const row = rows.at(-1);
    const nextWidth = row ? row.width + gap + seed.w : seed.w;
    if (row && nextWidth <= maxRowWidth) {
      row.seeds.push(seed);
      row.width = nextWidth;
      row.height = Math.max(row.height, seed.h);
    } else {
      rows.push({ seeds: [seed], width: seed.w, height: seed.h });
    }
  }

  const totalHeight = rows.reduce((height, row) => height + row.height, 0) + gap * (rows.length - 1);
  let y = anchor.y - totalHeight / 2;
  const placements: PlacementPoint[] = [];
  for (const row of rows) {
    let x = anchor.x - row.width / 2;
    for (const seed of row.seeds) {
      placements.push({ x, y });
      x += seed.w + gap;
    }
    y += row.height + gap;
  }
  return placements;
}
