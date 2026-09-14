// SPDX-License-Identifier: LicenseRef-BSL-1.1
'use client';

import { useEffect, useRef } from 'react';
import type { SiteCollection } from '@/lib/site-analysis';
import 'maplibre-gl/dist/maplibre-gl.css';

type Props = {
  lat: number;
  lon: number;
  radius: number;
  collection: SiteCollection | null;
  imagery: 'streets' | 'earth';
  onPick: (lat: number, lon: number) => void;
  onReady?: () => void;
};

const nasaTiles = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration/default/2004-12-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg';
const osmTiles = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

function circle(lat: number, lon: number, radius: number) {
  const points = Array.from({ length: 64 }, (_, index) => {
    const angle = index / 64 * Math.PI * 2;
    const north = Math.cos(angle) * radius / 111_320;
    const east = Math.sin(angle) * radius / (111_320 * Math.max(0.05, Math.cos(lat * Math.PI / 180)));
    return [lon + east, lat + north];
  });
  points.push([...points[0]]);
  return { type: 'FeatureCollection' as const, features: [{ type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [points] } }] };
}

export function GeoStage({ lat, lon, radius, collection, imagery, onPick, onReady }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import('maplibre-gl').Map | null>(null);
  const markerRef = useRef<import('maplibre-gl').Marker | null>(null);
  const siteRef = useRef({ lat, lon, radius });
  siteRef.current = { lat, lon, radius };
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    if (!container.current) return;
    let disposed = false;
    let map: import('maplibre-gl').Map | null = null;
    void import('maplibre-gl').then((maplibregl) => {
      if (disposed || !container.current) return;
      map = new maplibregl.Map({
        container: container.current,
        style: {
          version: 8,
          sources: {
            earth: { type: 'raster', tiles: [nasaTiles], tileSize: 256, maxzoom: 8, attribution: 'NASA Earth Observatory / GIBS' },
            streets: { type: 'raster', tiles: [osmTiles], tileSize: 256, maxzoom: 19, attribution: '© OpenStreetMap contributors' }
          },
          layers: [
            { id: 'earth', type: 'raster', source: 'earth', layout: { visibility: imagery === 'earth' ? 'visible' : 'none' } },
            { id: 'streets', type: 'raster', source: 'streets', layout: { visibility: imagery === 'streets' ? 'visible' : 'none' } }
          ]
        },
        center: [lon, lat], zoom: 14, minZoom: 1.4, maxZoom: 18,
        attributionControl: false
      });
      mapRef.current = map;
      map.on('style.load', () => map?.setProjection({ type: 'globe' }));
      const markerElement = document.createElement('div');
      markerElement.style.cssText = 'width:72px;height:72px;border:2px solid #ffc976;border-radius:50%;background:#ffc97616;box-shadow:0 0 0 3px #071419,0 0 30px #071419;pointer-events:none;display:grid;place-items:center';
      const centerDot = document.createElement('span');
      centerDot.style.cssText = 'width:13px;height:13px;border:3px solid #ffc976;border-radius:50%;background:#102329;box-shadow:0 0 0 3px #102329,0 0 20px #ffc976';
      markerElement.append(centerDot);
      markerRef.current = new maplibregl.Marker({ element: markerElement, anchor: 'center' }).setLngLat([lon, lat]).addTo(map);
      const sizeBoundary = () => {
        if (!map) return;
        const site = siteRef.current;
        const offset = site.radius / (111_320 * Math.max(0.05, Math.cos(site.lat * Math.PI / 180)));
        const center = map.project([site.lon, site.lat]);
        const edge = map.project([site.lon + offset, site.lat]);
        const size = Math.max(18, Math.min(1200, Math.abs(edge.x - center.x) * 2));
        markerElement.style.width = `${size}px`;
        markerElement.style.height = `${size}px`;
      };
      map.on('move', sizeBoundary);
      map.on('load', sizeBoundary);
      map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), 'bottom-right');
      map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
      map.on('click', (event) => pickRef.current(Number(event.lngLat.lat.toFixed(6)), Number(event.lngLat.lng.toFixed(6))));
      map.on('load', () => {
        if (!map || disposed) return;
        map.addSource('study-area', { type: 'geojson', data: circle(lat, lon, radius) });
        map.addLayer({ id: 'study-fill', type: 'fill', source: 'study-area', paint: { 'fill-color': '#ffc976', 'fill-opacity': 0.1 } });
        map.addLayer({ id: 'study-edge', type: 'line', source: 'study-area', paint: { 'line-color': '#ffc976', 'line-width': 2, 'line-dasharray': [2, 2] } });
        map.addSource('site-data', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer({ id: 'site-fill', type: 'fill', source: 'site-data', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#69d7e5', 'fill-opacity': 0.14 } });
        map.addLayer({ id: 'site-line', type: 'line', source: 'site-data', paint: { 'line-color': '#37bed1', 'line-width': 1.1, 'line-opacity': 0.72 } });
        onReady?.();
      });
    });
    return () => { disposed = true; markerRef.current?.remove(); markerRef.current = null; map?.remove(); mapRef.current = null; };
    // The map owns its lifecycle; later props update its sources and camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.flyTo({ center: [lon, lat], zoom: imagery === 'earth' ? 7 : Math.max(map.getZoom(), 14), essential: true, duration: 800 });
    markerRef.current?.setLngLat([lon, lat]);
    (map.getSource('study-area') as import('maplibre-gl').GeoJSONSource | undefined)?.setData(circle(lat, lon, radius));
  }, [lat, lon, radius, imagery]);

  useEffect(() => {
    (mapRef.current?.getSource('site-data') as import('maplibre-gl').GeoJSONSource | undefined)?.setData((collection || { type: 'FeatureCollection', features: [] }) as import('geojson').FeatureCollection);
  }, [collection]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer('earth')) return;
    map.setLayoutProperty('earth', 'visibility', imagery === 'earth' ? 'visible' : 'none');
    map.setLayoutProperty('streets', 'visibility', imagery === 'streets' ? 'visible' : 'none');
    map.flyTo({ center: [lon, lat], zoom: imagery === 'earth' ? 7 : 14, duration: 850, essential: true });
  }, [imagery, lat, lon]);

  return <div ref={container} aria-label="Interactive site map. Click to set the site point." role="application" style={{ position: 'absolute', inset: 0 }} />;
}
