/**
 * Freehand ink strokes.
 *
 * Points are stored flat (`[x0, y0, x1, y1, …]`) and relative to the node's own
 * origin, so a stroke survives the node being moved and costs one number per
 * coordinate in the saved document rather than an object per point.
 *
 * A pointer emits far more samples than a drawing needs — often several hundred
 * for a short line. Every one of those would be written to disk on autosave and
 * cloned into history, so strokes are simplified once, on release.
 */

export type InkStroke = {
   /** Flat [x, y, …] pairs, relative to the node origin. */
  points: number[];
  color: string;
  width: number;
};

export const INK_DEFAULT_COLOR = '#171717';
export const INK_DEFAULT_WIDTH = 3;
/** Simplification tolerance in workspace units. Below a pen's own jitter. */
export const INK_SIMPLIFY_TOLERANCE = 0.75;
/**
 * Point cap applied before simplification.
 *
 * Douglas–Peucker is O(n²) in the worst case — a stroke where every point is a
 * genuine corner never prunes a subrange. A real stroke is nowhere near this
 * cap (a 30-second drag at 120Hz is ~3,600 points), but simplification runs
 * synchronously on pointer release, so an unbounded input could freeze the
 * canvas. Anything longer is uniformly decimated first.
 */
export const INK_MAX_POINTS = 4_000;
/** Ink padding around the drawn bounds, so thick strokes are not clipped. */
export const INK_PADDING = 12;

/**
 * Uniformly thin a stroke to at most `maxPoints` points, always keeping the
 * last one so the stroke still ends where the pen was lifted.
 */
export function decimateStroke(points: number[], maxPoints = INK_MAX_POINTS): number[] {
  const count = Math.floor(points.length / 2);
  if (count <= maxPoints) return points;
  const stride = Math.ceil(count / maxPoints);
  const thinned: number[] = [];
  for (let index = 0; index < count; index += stride) {
    thinned.push(points[index * 2], points[index * 2 + 1]);
   }
  const lastX = points[(count - 1) * 2];
  const lastY = points[(count - 1) * 2 + 1];
  if (thinned[thinned.length - 2] !== lastX || thinned[thinned.length - 1] !== lastY) {
    thinned.push(lastX, lastY);
   }
  return thinned;
}

function perpendicularDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
  const clamped = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + clamped * dx), py - (ay + clamped * dy));
}

/**
 * Ramer–Douglas–Peucker: drop points that lie close to the line between the ones
 * that survive. Iterative rather than recursive so a long stroke cannot blow the
 * stack.
 */
export function simplifyStroke(points: number[], tolerance = INK_SIMPLIFY_TOLERANCE): number[] {
     // Aggressively cap before D-P to prevent O(n^2) on pathological inputs like pure zigzags.
  let cappedPoints = decimateStroke(points, Math.min(INK_MAX_POINTS, 5_000));

     // If still too large after initial decimation, downsample further.
  const maxDPPoints = 2_000;
  if (Math.floor(cappedPoints.length / 2) > maxDPPoints) {
    cappedPoints = decimateStroke(cappedPoints, maxDPPoints);
   }

  const count = Math.floor(cappedPoints.length / 2);
  if (count < 3 || tolerance <= 0) return [...cappedPoints];

  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[count - 1] = 1;
  const stack: Array<[number, number]> = [[0, count - 1]];

  while (stack.length) {
    const [first, last] = stack.pop()!;
    if (last - first < 2) continue;
    let worst = 0;
    let worstIndex = -1;
    for (let index = first + 1; index < last; index += 1) {
      const distance = perpendicularDistance(
        cappedPoints[index * 2], cappedPoints[index * 2 + 1],
        cappedPoints[first * 2], cappedPoints[first * 2 + 1],
        cappedPoints[last * 2], cappedPoints[last * 2 + 1]
         );
      if (distance > worst) {
        worst = distance;
        worstIndex = index;
       }
     }
    if (worstIndex >= 0 && worst > tolerance) {
      keep[worstIndex] = 1;
      stack.push([first, worstIndex], [worstIndex, last]);
     }
   }

  const simplified: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if (!keep[index]) continue;
    simplified.push(cappedPoints[index * 2], cappedPoints[index * 2 + 1]);
   }
  return simplified;
}

export type InkBounds = { x: number; y: number; w: number; h: number };

/** Tight bounds of a set of strokes, padded for stroke width. */
export function strokeBounds(strokes: InkStroke[], padding = INK_PADDING): InkBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    for (let index = 0; index < stroke.points.length; index += 2) {
      const x = stroke.points[index];
      const y = stroke.points[index + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
     }
   }
  if (!Number.isFinite(minX)) return null;
  return {
    x: minX - padding,
    y: minY - padding,
    w: maxX - minX + padding * 2,
    h: maxY - minY + padding * 2
   };
}

/** Shift every stroke by a delta — used to keep points relative after a re-fit. */
export function translateStrokes(strokes: InkStroke[], dx: number, dy: number): InkStroke[] {
  if (dx === 0 && dy === 0) return strokes;
  return strokes.map((stroke) => ({
     ...stroke,
    points: stroke.points.map((value, index) => index % 2 === 0 ? value + dx : value + dy)
   }));
}

/**
 * Adapt the original scaffolded ink shape — a single stroke stored as
 * `payload.points: [{x, y}, …]` — to the flat format. No drawing tool ever
 * produced it, but a hand-authored or scripted node may still carry it.
 */
export function readLegacyStroke(payload: Record<string, unknown>): InkStroke | null {
  const points = payload.points;
  if (!Array.isArray(points) || points.length < 2) return null;
  const flat: number[] = [];
  for (const point of points) {
    if (!point || typeof point !== 'object') continue;
    const { x, y } = point as { x?: unknown; y?: unknown };
    if (typeof x !== 'number' || typeof y !== 'number') continue;
    flat.push(x, y);
   }
  if (flat.length < 4) return null;
  return {
    points: flat,
    color: typeof payload.color === 'string' ? payload.color : INK_DEFAULT_COLOR,
    width: typeof payload.width === 'number' && payload.width > 0 ? payload.width : INK_DEFAULT_WIDTH
   };
}

/** Read strokes off a node payload, discarding anything malformed. */
export function readStrokes(raw: unknown): InkStroke[] {
  if (!Array.isArray(raw)) return [];
  const strokes: InkStroke[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const stroke = entry as Record<string, unknown>;
    const points = Array.isArray(stroke.points)
       ? stroke.points.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
       : [];
     // An odd count means a truncated pair; drop the orphan rather than reading
     // the next stroke's x as this one's y.
    if (points.length < 4) continue;
    strokes.push({
      points: points.length % 2 === 0 ? points : points.slice(0, -1),
      color: typeof stroke.color === 'string' ? stroke.color.slice(0, 32) : INK_DEFAULT_COLOR,
      width: typeof stroke.width === 'number' && stroke.width > 0 ? Math.min(64, stroke.width) : INK_DEFAULT_WIDTH
     });
   }
  return strokes;
}

/** Render strokes into a 2D context already translated to the node origin. */
export function paintStrokes(context: CanvasRenderingContext2D, strokes: InkStroke[]) {
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const stroke of strokes) {
    if (stroke.points.length < 4) continue;
    context.beginPath();
    context.strokeStyle = stroke.color;
    context.lineWidth = stroke.width;
    context.moveTo(stroke.points[0], stroke.points[1]);
     // Quadratic midpoints turn a sampled polyline into a smooth curve without
     // needing to store control points.
    for (let index = 2; index < stroke.points.length - 2; index += 2) {
      const midX = (stroke.points[index] + stroke.points[index + 2]) / 2;
      const midY = (stroke.points[index + 1] + stroke.points[index + 3]) / 2;
      context.quadraticCurveTo(stroke.points[index], stroke.points[index + 1], midX, midY);
     }
    context.lineTo(stroke.points[stroke.points.length - 2], stroke.points[stroke.points.length - 1]);
    context.stroke();
   }
}
