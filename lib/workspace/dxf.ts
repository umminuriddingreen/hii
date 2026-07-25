export type DxfPoint = { x: number; y: number };

export type DxfPrimitive =
  | { kind: 'line'; layer: string; from: DxfPoint; to: DxfPoint }
  | { kind: 'polyline'; layer: string; points: DxfPoint[]; closed: boolean }
  | { kind: 'circle'; layer: string; center: DxfPoint; radius: number }
  | { kind: 'arc'; layer: string; center: DxfPoint; radius: number; startAngle: number; endAngle: number }
  | { kind: 'point'; layer: string; point: DxfPoint }
  | { kind: 'text'; layer: string; point: DxfPoint; text: string; height: number };

export type DxfDrawing = {
  primitives: DxfPrimitive[];
  layers: string[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  units: string;
  unsupported: string[];
};

type Pair = { code: number; value: string };

const unitsByCode: Record<number, string> = {
  0: 'unitless',
  1: 'in',
  2: 'ft',
  4: 'mm',
  5: 'cm',
  6: 'm',
  9: 'mil',
  10: 'yd'
};

function number(values: Map<number, string[]>, code: number, index = 0) {
  const value = Number(values.get(code)?.[index]);
  return Number.isFinite(value) ? value : 0;
}

function text(values: Map<number, string[]>, code: number, index = 0) {
  return values.get(code)?.[index]?.trim() || '';
}

function entityValues(pairs: Pair[]) {
  const values = new Map<number, string[]>();
  for (const pair of pairs) values.set(pair.code, [...(values.get(pair.code) || []), pair.value]);
  return values;
}

function parseEntity(type: string, pairs: Pair[]): DxfPrimitive | null {
  const values = entityValues(pairs);
  const layer = text(values, 8) || '0';
  if (type === 'LINE') {
    return {
      kind: 'line',
      layer,
      from: { x: number(values, 10), y: number(values, 20) },
      to: { x: number(values, 11), y: number(values, 21) }
    };
  }
  if (type === 'LWPOLYLINE') {
    const xs = values.get(10) || [];
    const ys = values.get(20) || [];
    const points = xs
      .map((value, index) => ({ x: Number(value), y: Number(ys[index]) }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (points.length < 2) return null;
    return { kind: 'polyline', layer, points, closed: (number(values, 70) & 1) === 1 };
  }
  if (type === 'CIRCLE') {
    const radius = Math.abs(number(values, 40));
    return radius > 0 ? { kind: 'circle', layer, center: { x: number(values, 10), y: number(values, 20) }, radius } : null;
  }
  if (type === 'ARC') {
    const radius = Math.abs(number(values, 40));
    return radius > 0
      ? {
          kind: 'arc',
          layer,
          center: { x: number(values, 10), y: number(values, 20) },
          radius,
          startAngle: number(values, 50),
          endAngle: number(values, 51)
        }
      : null;
  }
  if (type === 'POINT') return { kind: 'point', layer, point: { x: number(values, 10), y: number(values, 20) } };
  if (type === 'TEXT' || type === 'MTEXT') {
    const content = [...(values.get(3) || []), ...(values.get(1) || [])].join('').replace(/\\P/g, ' ').trim();
    if (!content) return null;
    return {
      kind: 'text',
      layer,
      point: { x: number(values, 10), y: number(values, 20) },
      text: content.slice(0, 500),
      height: Math.max(Math.abs(number(values, 40)), 1)
    };
  }
  return null;
}

function boundsFor(primitives: DxfPrimitive[]) {
  const points: DxfPoint[] = [];
  for (const primitive of primitives) {
    if (primitive.kind === 'line') points.push(primitive.from, primitive.to);
    if (primitive.kind === 'polyline') points.push(...primitive.points);
    if (primitive.kind === 'point' || primitive.kind === 'text') points.push(primitive.point);
    if (primitive.kind === 'circle' || primitive.kind === 'arc') {
      points.push(
        { x: primitive.center.x - primitive.radius, y: primitive.center.y - primitive.radius },
        { x: primitive.center.x + primitive.radius, y: primitive.center.y + primitive.radius }
      );
    }
  }
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys)
  };
}

export function parseDxf(source: string): DxfDrawing {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const pairs: Pair[] = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = Number.parseInt(lines[index].trim(), 10);
    if (Number.isFinite(code)) pairs.push({ code, value: lines[index + 1].trimEnd() });
  }

  let inEntities = false;
  let currentType = '';
  let currentPairs: Pair[] = [];
  let units = 'unitless';
  const primitives: DxfPrimitive[] = [];
  const unsupported = new Set<string>();
  const known = new Set(['LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC', 'POINT', 'TEXT', 'MTEXT']);

  const flush = () => {
    if (!currentType) return;
    const primitive = parseEntity(currentType, currentPairs);
    if (primitive) primitives.push(primitive);
    else if (!known.has(currentType)) unsupported.add(currentType);
    currentType = '';
    currentPairs = [];
  };

  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    if (pair.code === 9 && pair.value.trim() === '$INSUNITS') {
      const code = Number(pairs[index + 1]?.value);
      units = unitsByCode[code] || `units ${code}`;
    }
    if (pair.code === 0 && pair.value.trim() === 'SECTION' && pairs[index + 1]?.code === 2 && pairs[index + 1]?.value.trim() === 'ENTITIES') {
      inEntities = true;
      index += 1;
      continue;
    }
    if (!inEntities) continue;
    if (pair.code === 0 && pair.value.trim() === 'ENDSEC') {
      flush();
      break;
    }
    if (pair.code === 0) {
      flush();
      currentType = pair.value.trim().toUpperCase();
      continue;
    }
    if (currentType) currentPairs.push(pair);
  }
  flush();

  if (!primitives.length) throw new Error('No supported drawing entities were found in this DXF.');
  return {
    primitives,
    layers: [...new Set(primitives.map((primitive) => primitive.layer))].sort(),
    bounds: boundsFor(primitives),
    units,
    unsupported: [...unsupported].sort()
  };
}
