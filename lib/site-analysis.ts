// SPDX-License-Identifier: LicenseRef-BSL-1.1
export type SiteGeometry =
  | { type: 'LineString'; coordinates: number[][] }
  | { type: 'MultiLineString' | 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] }
  | { type: string; coordinates?: unknown };
export type SiteFeature = { type: 'Feature'; id?: string | number; properties: Record<string, unknown>; geometry: SiteGeometry | null };
export type SiteCollection = { type: 'FeatureCollection'; features: SiteFeature[] };

type OsmElement = {
  type: 'node' | 'way'; id: number; lat?: number; lon?: number;
  nodes?: number[]; tags?: Record<string, string>;
};

export function siteBounds(lat: number, lon: number, radiusMeters: number) {
  const latDelta = radiusMeters / 111_320;
  const lonDelta = radiusMeters / (111_320 * Math.max(0.05, Math.cos(lat * Math.PI / 180)));
  return [lat - latDelta, lon - lonDelta, lat + latDelta, lon + lonDelta] as const;
}

export function osmToGeoJSON(elements: OsmElement[]): SiteCollection {
  const nodes = new Map(elements.filter((item) => item.type === 'node' && Number.isFinite(item.lat) && Number.isFinite(item.lon)).map((item) => [item.id, [item.lon!, item.lat!] as [number, number]]));
  const features: SiteFeature[] = [];
  for (const item of elements) {
    if (item.type !== 'way' || !item.nodes?.length || !item.tags) continue;
    const coordinates = item.nodes.map((id) => nodes.get(id)).filter((point): point is [number, number] => Boolean(point));
    if (coordinates.length !== item.nodes.length || coordinates.length < 2) continue;
    const closed = coordinates.length > 3 && coordinates[0][0] === coordinates.at(-1)![0] && coordinates[0][1] === coordinates.at(-1)![1];
    const polygon = closed && Boolean(item.tags.building || item.tags.landuse);
    features.push({
      type: 'Feature',
      id: `osm:way:${item.id}`,
      properties: { ...item.tags, source: 'OpenStreetMap', sourceUrl: `https://www.openstreetmap.org/way/${item.id}` },
      geometry: polygon ? { type: 'Polygon', coordinates: [coordinates] } : { type: 'LineString', coordinates }
    });
  }
  return { type: 'FeatureCollection', features };
}

export function osmXmlToGeoJSON(xml: string): SiteCollection {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('The map source returned invalid XML.');
  const elements: OsmElement[] = [];
  document.querySelectorAll('node').forEach((node) => elements.push({ type: 'node', id: Number(node.getAttribute('id')), lat: Number(node.getAttribute('lat')), lon: Number(node.getAttribute('lon')) }));
  document.querySelectorAll('way').forEach((way) => {
    const tags: Record<string, string> = {};
    way.querySelectorAll('tag').forEach((tag) => { const key = tag.getAttribute('k'); const value = tag.getAttribute('v'); if (key && value) tags[key] = value; });
    if (!('building' in tags || 'highway' in tags || 'waterway' in tags || 'landuse' in tags)) return;
    const nodes = Array.from(way.querySelectorAll('nd'), (node) => Number(node.getAttribute('ref')));
    elements.push({ type: 'way', id: Number(way.getAttribute('id')), nodes, tags });
  });
  return osmToGeoJSON(elements);
}

export function validGeoJSON(value: unknown): SiteCollection {
  if (!value || typeof value !== 'object') throw new Error('The file is not GeoJSON.');
  const input = value as { type?: string; features?: unknown };
  if (input.type !== 'FeatureCollection' || !Array.isArray(input.features) || input.features.length > 20_000) throw new Error('Use a GeoJSON FeatureCollection with up to 20,000 features.');
  for (const feature of input.features) {
    if (!feature || typeof feature !== 'object' || (feature as { type?: string }).type !== 'Feature') throw new Error('The GeoJSON contains an invalid feature.');
  }
  return input as SiteCollection;
}

function projected(point: number[], lat: number, lon: number): [number, number] {
  return [(point[0] - lon) * 111_320 * Math.cos(lat * Math.PI / 180), (point[1] - lat) * 111_320];
}

export function siteDxf(collection: SiteCollection, lat: number, lon: number) {
  const lines = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '6', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
  const addLine = (a: number[], b: number[], layer: string) => {
    const [x1, y1] = projected(a, lat, lon);
    const [x2, y2] = projected(b, lat, lon);
    lines.push('0', 'LINE', '8', layer, '10', x1.toFixed(3), '20', y1.toFixed(3), '30', '0', '11', x2.toFixed(3), '21', y2.toFixed(3), '31', '0');
  };
  for (const feature of collection.features) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    const paths: number[][][] = geometry.type === 'LineString' && Array.isArray(geometry.coordinates) ? [geometry.coordinates as number[][]]
      : (geometry.type === 'MultiLineString' || geometry.type === 'Polygon') && Array.isArray(geometry.coordinates) ? geometry.coordinates as number[][][]
      : geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates) ? (geometry.coordinates as number[][][][]).flat() : [];
    const props = feature.properties || {};
    const layer = (props.building ? 'BUILDINGS' : props.highway ? 'ROADS' : props.waterway ? 'WATER' : 'SITE').slice(0, 30);
    for (const path of paths) for (let index = 1; index < path.length; index++) addLine(path[index - 1], path[index], layer);
  }
  lines.push('0', 'ENDSEC', '0', 'EOF');
  return lines.join('\n') + '\n';
}

export function solarPosition(date: Date, latitude: number, longitude: number) {
  const epoch = date.getTime() / 86_400_000 + 2_440_587.5;
  const days = epoch - 2_451_545;
  const meanLongitude = (280.46 + 0.9856474 * days) * Math.PI / 180;
  const meanAnomaly = (357.528 + 0.9856003 * days) * Math.PI / 180;
  const eclipticLongitude = meanLongitude + (1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * Math.PI / 180;
  const obliquity = (23.439 - 0.0000004 * days) * Math.PI / 180;
  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude));
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  const sidereal = (280.46061837 + 360.98564736629 * days) * Math.PI / 180;
  const hourAngle = sidereal + longitude * Math.PI / 180 - rightAscension;
  const phi = latitude * Math.PI / 180;
  const altitude = Math.asin(Math.sin(phi) * Math.sin(declination) + Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle));
  const azimuth = (Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(phi) - Math.tan(declination) * Math.cos(phi)) * 180 / Math.PI + 180 + 360) % 360;
  return { altitude: altitude * 180 / Math.PI, azimuth };
}
