// SPDX-License-Identifier: LicenseRef-BSL-1.1
import { describe, expect, it } from 'vitest';
import { osmToGeoJSON, osmXmlToGeoJSON, siteBounds, siteDxf, solarPosition, validGeoJSON } from '../../lib/site-analysis';

describe('site analysis data', () => {
  it('converts complete OSM ways and leaves incomplete ways out of CAD export', () => {
    const collection = osmToGeoJSON([
      { type: 'node', id: 1, lat: 40, lon: -74 },
      { type: 'node', id: 2, lat: 40, lon: -73.999 },
      { type: 'node', id: 3, lat: 40.001, lon: -73.999 },
      { type: 'way', id: 4, nodes: [1, 2, 3, 1], tags: { building: 'yes' } },
      { type: 'way', id: 5, nodes: [1, 99], tags: { highway: 'residential' } }
    ]);
    expect(collection.features).toHaveLength(1);
    expect(collection.features[0].geometry?.type).toBe('Polygon');
    expect(siteDxf(collection, 40, -74)).toContain('BUILDINGS');
    expect(siteDxf(collection, 40, -74)).not.toContain('NaN');
  });

  it('bounds retrieval and rejects malformed collections', () => {
    expect(siteBounds(40, -74, 500)[0]).toBeLessThan(40);
    expect(() => validGeoJSON({ type: 'FeatureCollection', features: [{ type: 'bad' }] })).toThrow();
    const xml = '<osm><node id="1" lat="40" lon="-74"/><node id="2" lat="40" lon="-73.999"/><way id="3"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way></osm>';
    expect(osmXmlToGeoJSON(xml).features[0].properties.highway).toBe('residential');
  });

  it('places the sun above the equator near the March equinox at noon UTC', () => {
    const position = solarPosition(new Date('2026-03-20T12:00:00Z'), 0, 0);
    expect(position.altitude).toBeGreaterThan(85);
    expect(position.altitude).toBeLessThanOrEqual(90);
  });
});
