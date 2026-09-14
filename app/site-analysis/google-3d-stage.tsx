// SPDX-License-Identifier: LicenseRef-BSL-1.1
'use client';

import { useEffect, useRef } from 'react';

type Point = { lat: number; lng: number; altitude?: number };
type GoogleMap = HTMLElement & { center: Point; range: number };
type GooglePolygon = HTMLElement & { path: Point[] };
type Maps3D = {
  Map3DElement: new (options: object) => GoogleMap;
  Polygon3DElement: new (options: object) => GooglePolygon;
};

declare global {
  interface Window { google?: { maps: { importLibrary: (name: string) => Promise<Maps3D> } } }
}

let scriptPromise: Promise<void> | null = null;
function loadGoogleMaps(key: string) {
  if (window.google?.maps?.importLibrary) return Promise.resolve();
  if (!scriptPromise) scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://maps.googleapis.com/maps/api/js?loading=async&v=weekly&libraries=maps3d&key=${encodeURIComponent(key)}`;
    script.onload = () => window.google?.maps?.importLibrary ? resolve() : reject(new Error('Google 3D did not initialize.'));
    script.onerror = () => reject(new Error('Google 3D could not load. Check the API key and billing setup.'));
    document.head.append(script);
  }).catch((error) => { scriptPromise = null; throw error; });
  return scriptPromise;
}

function boundary(lat: number, lng: number, radius: number): Point[] {
  return Array.from({ length: 65 }, (_, index) => {
    const angle = index / 64 * Math.PI * 2;
    return { lat: lat + Math.cos(angle) * radius / 111_320, lng: lng + Math.sin(angle) * radius / (111_320 * Math.max(0.05, Math.cos(lat * Math.PI / 180))) };
  });
}

export function Google3DStage({ lat, lon, radius, apiKey, onPick, onError }: { lat: number; lon: number; radius: number; apiKey: string; onPick: (lat: number, lon: number) => void; onError: (message: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<GoogleMap | null>(null);
  const polygonRef = useRef<GooglePolygon | null>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    let disposed = false;
    void loadGoogleMaps(apiKey).then(async () => {
      const { Map3DElement, Polygon3DElement } = await window.google!.maps.importLibrary('maps3d');
      if (disposed || !container.current) return;
      const map = new Map3DElement({ center: { lat, lng: lon, altitude: 0 }, range: 1800, tilt: 55, heading: 0, mode: 'HYBRID' });
      map.style.cssText = 'width:100%;height:100%;display:block';
      map.setAttribute('aria-label', 'Google 3D site view');
      map.addEventListener('gmp-click', (event) => {
        const point = (event as Event & { position?: Point }).position;
        if (point) pickRef.current(Number(point.lat.toFixed(6)), Number(point.lng.toFixed(6)));
      });
      map.addEventListener('gmp-error', () => onError('Google 3D could not render this site. Check key restrictions and billing.'));
      const polygon = new Polygon3DElement({ strokeColor: '#ffc976', strokeWidth: 3, fillColor: '#ffc97633', altitudeMode: 'CLAMP_TO_GROUND' });
      polygon.path = boundary(lat, lon, radius);
      map.append(polygon);
      container.current.append(map);
      mapRef.current = map;
      polygonRef.current = polygon;
    }).catch((error) => { if (!disposed) onError(error instanceof Error ? error.message : 'Google 3D is unavailable.'); });
    return () => { disposed = true; mapRef.current?.remove(); mapRef.current = null; polygonRef.current = null; };
    // The 3D map is retained while the selected site changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  useEffect(() => {
    if (mapRef.current) mapRef.current.center = { lat, lng: lon, altitude: 0 };
    if (polygonRef.current) polygonRef.current.path = boundary(lat, lon, radius);
  }, [lat, lon, radius]);

  return <div ref={container} style={{ position: 'absolute', inset: 0 }} />;
}
