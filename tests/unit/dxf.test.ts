import { describe, expect, it } from 'vitest';
import { parseDxf } from '../../lib/workspace/dxf';

const sample = [
  '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'LINE', '8', 'walls', '10', '0', '20', '0', '11', '100', '21', '0',
  '0', 'LWPOLYLINE', '8', 'outline', '70', '1', '10', '0', '20', '0', '10', '100', '20', '0', '10', '100', '20', '50',
  '0', 'CIRCLE', '8', 'fixtures', '10', '25', '20', '25', '40', '5',
  '0', 'ARC', '8', 'doors', '10', '50', '20', '0', '40', '10', '50', '0', '51', '90',
  '0', 'TEXT', '8', 'labels', '10', '5', '20', '8', '40', '3', '1', 'ROOM 101',
  '0', 'HATCH', '8', 'fills',
  '0', 'ENDSEC', '0', 'EOF'
].join('\n');

describe('DXF workspace parser', () => {
  it('parses common 2D drawing entities, layers, bounds, and units', () => {
    const drawing = parseDxf(sample);

    expect(drawing.units).toBe('mm');
    expect(drawing.primitives).toHaveLength(5);
    expect(drawing.layers).toEqual(['doors', 'fixtures', 'labels', 'outline', 'walls']);
    expect(drawing.bounds).toEqual({ minX: 0, minY: -10, maxX: 100, maxY: 50 });
    expect(drawing.unsupported).toContain('HATCH');
    expect(drawing.primitives[1]).toMatchObject({ kind: 'polyline', closed: true });
  });

  it('rejects drawings without renderable entities', () => {
    expect(() => parseDxf('0\nSECTION\n2\nENTITIES\n0\nHATCH\n0\nENDSEC\n0\nEOF')).toThrow(
      'No supported drawing entities'
    );
  });
});
