// SPDX-License-Identifier: LicenseRef-BSL-1.1
'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { osmXmlToGeoJSON, siteDxf, solarPosition, validGeoJSON, type SiteCollection } from '@/lib/site-analysis';
import styles from './site-analysis.module.css';
import { GeoStage } from './geo-stage';
import { Google3DStage } from './google-3d-stage';

type HistoryItem = { pageid: number; title: string; lat: number; lon: number; dist: number };
type ImportedFile = { name: string; kind: string; size: number; url?: string };
type CommunityRecord = { id: string; kind: 'request' | 'source'; category: string; title: string; note: string; sourceUrl?: string; sourceDate?: string; authorHandle: string; createdAt: number };

function download(name: string, value: string, type: string) {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function SiteAnalysis() {
  const [latitude, setLatitude] = useState('40.7426');
  const [longitude, setLongitude] = useState('-74.1790');
  const [radius, setRadius] = useState(500);
  const [siteName, setSiteName] = useState('Newark site study');
  const [collection, setCollection] = useState<SiteCollection | null>(null);
  const [status, setStatus] = useState('Choose a site, then retrieve its context.');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyStatus, setHistoryStatus] = useState('');
  const [community, setCommunity] = useState<CommunityRecord[]>([]);
  const [communityStatus, setCommunityStatus] = useState('');
  const [recordKind, setRecordKind] = useState<'request' | 'source'>('request');
  const [recordCategory, setRecordCategory] = useState('history');
  const [recordTitle, setRecordTitle] = useState('');
  const [recordNote, setRecordNote] = useState('');
  const [recordUrl, setRecordUrl] = useState('');
  const [files, setFiles] = useState<ImportedFile[]>([]);
  const [dateTime, setDateTime] = useState('2026-06-21T12:00');
  const [panel, setPanel] = useState<'site' | 'history' | 'design' | 'climate'>('site');
  const [imagery, setImagery] = useState<'streets' | 'earth' | 'google'>('streets');
  const [mapReady, setMapReady] = useState(false);
  const lat = Number(latitude);
  const lon = Number(longitude);
  const validSite = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 85 && Math.abs(lon) <= 180 && radius >= 100 && radius <= 500;
  const earthUrl = validSite ? `https://earth.google.com/web/search/${lat},${lon}` : '';
  const sun = useMemo(() => validSite && !Number.isNaN(new Date(dateTime).getTime()) ? solarPosition(new Date(dateTime), lat, lon) : null, [dateTime, lat, lon, validSite]);
  const buildings = collection?.features.filter((feature) => Boolean(feature.properties?.building)).length || 0;
  const roads = collection?.features.filter((feature) => Boolean(feature.properties?.highway)).length || 0;
  const google3DKey = process.env.NEXT_PUBLIC_HII_GOOGLE_MAPS_API_KEY;

  useEffect(() => () => { files.forEach((file) => { if (file.url) URL.revokeObjectURL(file.url); }); }, [files]);

  async function retrieve(event?: FormEvent) {
    event?.preventDefault();
    if (!validSite) { setStatus('Enter valid coordinates and a radius between 100 and 500 m.'); return; }
    setBusy(true);
    setStatus('Retrieving bounded OpenStreetMap features…');
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`/api/site-osm?lat=${lat}&lon=${lon}&radius=${radius}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Source returned ${response.status}.`);
      const result = osmXmlToGeoJSON(await response.text());
      setCollection(result);
      setStatus(`${result.features.length} sourced features retrieved. OpenStreetMap coverage varies by site.`);
    } catch (error) {
      setStatus(`Context unavailable: ${error instanceof Error ? error.message : 'request failed'}. Try a smaller radius or import GeoJSON.`);
    } finally { window.clearTimeout(timeout); setBusy(false); }
  }

  async function loadHistory() {
    if (!validSite) return;
    setHistoryStatus('Searching nearby historical and place records…');
    try {
      const response = await fetch(`/api/site-history?lat=${lat}&lon=${lon}`);
      if (!response.ok) throw new Error('The history source is unavailable.');
      const data = await response.json() as { query?: { geosearch?: HistoryItem[] } };
      const items = data.query?.geosearch || [];
      setHistory(items);
      setHistoryStatus(items.length ? `${items.length} nearby records. Check each article and its cited sources for historical claims.` : 'No nearby records found. Request or contribute a source below.');
    } catch { setHistoryStatus('History source unavailable. Try its direct link or request a community source.'); }
  }

  async function loadCommunity() {
    if (!validSite) return;
    try {
      const response = await fetch(`/api/site-records?lat=${lat}&lon=${lon}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('unavailable');
      const data = await response.json() as { items?: CommunityRecord[] };
      setCommunity(data.items || []);
      setCommunityStatus(data.items?.length ? '' : 'No community records near this site yet.');
    } catch { setCommunityStatus('Community records are unavailable in this environment.'); }
  }

  async function publishRecord(event: FormEvent) {
    event.preventDefault();
    if (!validSite) return;
    setCommunityStatus('Publishing…');
    try {
      const sessionResponse = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
      const session = await sessionResponse.json() as { authenticated?: boolean; csrfToken?: string };
      if (!session.authenticated || !session.csrfToken) throw new Error('Sign in to HII before contributing.');
      const response = await fetch('/api/site-records', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'x-hii-csrf': session.csrfToken }, body: JSON.stringify({ kind: recordKind, category: recordCategory, latitude: lat, longitude: lon, title: recordTitle, note: recordNote, sourceUrl: recordUrl || null, sourceDate: null }) });
      if (!response.ok) { const body = await response.json() as { error?: string }; throw new Error(body.error || 'Contribution failed.'); }
      setRecordTitle(''); setRecordNote(''); setRecordUrl('');
      setCommunityStatus('Published as a community-supplied record.');
      await loadCommunity();
    } catch (error) { setCommunityStatus(error instanceof Error ? error.message : 'Contribution failed.'); }
  }

  async function reportRecord(id: string) {
    try {
      const sessionResponse = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
      const session = await sessionResponse.json() as { authenticated?: boolean; csrfToken?: string };
      if (!session.authenticated || !session.csrfToken) throw new Error('Sign in to report a record.');
      const response = await fetch(`/api/site-records/${id}/report`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'x-hii-csrf': session.csrfToken }, body: JSON.stringify({ reason: 'inaccurate' }) });
      if (!response.ok) throw new Error('Report failed.');
      setCommunityStatus('Report received.');
    } catch (error) { setCommunityStatus(error instanceof Error ? error.message : 'Report failed.'); }
  }

  async function importFile(file: File) {
    const extension = file.name.split('.').pop()?.toLowerCase() || '';
    if (file.size > 50 * 1024 * 1024) { setStatus('Files must be 50 MB or smaller in this browser workflow.'); return; }
    if (extension === 'geojson' || extension === 'json') {
      try { const data = validGeoJSON(JSON.parse(await file.text())); setCollection(data); setStatus(`Imported ${data.features.length} GeoJSON features. Confirm coordinates before export.`); }
      catch (error) { setStatus(error instanceof Error ? error.message : 'Invalid GeoJSON.'); }
      return;
    }
    if (!['glb', 'gltf', 'pdf', 'dxf', 'dwg', '3dm', 'rvt', 'ifc', 'idf', 'gbxml'].includes(extension)) { setStatus('Unsupported file type.'); return; }
    const url = extension === 'pdf' || extension === 'glb' ? URL.createObjectURL(file) : undefined;
    setFiles((current) => [...current, { name: file.name, size: file.size, kind: extension, url }]);
    setStatus(['dwg', 'rvt'].includes(extension) ? 'File attached as a reference. Export it locally to DXF, IFC, or glTF for analysis.' : `${file.name} attached. Georeferencing and model conversion are required before simulation.`);
  }

  return <main className={styles.shell}>
    <div className={styles.mapSurface}>
      {validSite && imagery !== 'google' && <GeoStage lat={lat} lon={lon} radius={radius} collection={collection} imagery={imagery} onPick={(pickedLat, pickedLon) => { setLatitude(String(pickedLat)); setLongitude(String(pickedLon)); setCollection(null); setStatus('Site point selected. Retrieve the surrounding layers.'); setPanel('site'); }} onReady={() => setMapReady(true)} />}
      {validSite && imagery === 'google' && google3DKey && <Google3DStage lat={lat} lon={lon} radius={radius} apiKey={google3DKey} onPick={(pickedLat, pickedLon) => { setLatitude(String(pickedLat)); setLongitude(String(pickedLon)); setCollection(null); setStatus('Site point selected. Retrieve the surrounding layers.'); setPanel('site'); }} onError={(message) => { setImagery('streets'); setStatus(message); }} />}
      {!mapReady && <div className={styles.loading}>Preparing the geospatial workspace…</div>}
      <div className={styles.vignette} aria-hidden="true" />
    </div>

    <header className={styles.topbar}>
      <a className={styles.brand} href="/" aria-label="HII home"><span className={styles.brandMark}>hii</span><span className={styles.brandRule} /><span>Architecture</span></a>
      <div className={styles.workspaceTitle}><span className={styles.liveDot} /> SITE WORKSPACE <span className={styles.titleDivider}>/</span> <input aria-label="Project name" value={siteName} onChange={(event) => setSiteName(event.target.value)} maxLength={80} /></div>
      <a className={styles.storeLink} href="/store">App Store</a><a className={styles.earthLink} href={earthUrl || '#'} target="_blank" rel="noreferrer" aria-disabled={!validSite}>Open in Google Earth <span>↗</span></a>
    </header>

    <div className={styles.locationBar}>
      <div><span className={styles.eyebrow}>LOCATION</span><strong>{validSite ? `${lat.toFixed(5)}° N  /  ${Math.abs(lon).toFixed(5)}° ${lon < 0 ? 'W' : 'E'}` : 'Choose a location'}</strong></div>
      <span className={styles.locationHint}>Click anywhere on the map to set the site point</span>
    </div>

    <nav className={styles.toolRail} aria-label="Site tools">
      {([['site', '◎', 'Site file'], ['history', '◷', 'Place & people'], ['design', '◇', 'Design'], ['climate', '☼', 'Sun & energy']] as const).map(([id, glyph, label]) => <button key={id} type="button" title={label} aria-label={label} aria-pressed={panel === id} className={panel === id ? styles.toolActive : ''} onClick={() => setPanel(id)}><span>{glyph}</span><small>{label}</small></button>)}
    </nav>

    <aside className={styles.inspector} aria-label={`${panel} tools`}>
      {panel === 'site' && <>
        <div className={styles.panelHeader}><span className={styles.eyebrow}>SITE FILE</span><h1>Start with the ground.</h1><p>Choose a point, set the study area, and assemble a drawing-ready base.</p></div>
        <form className={styles.siteForm} onSubmit={retrieve}>
          <div className={styles.coordinates}><label>LATITUDE<input type="number" step="any" value={latitude} onChange={(event) => setLatitude(event.target.value)} /></label><label>LONGITUDE<input type="number" step="any" value={longitude} onChange={(event) => setLongitude(event.target.value)} /></label></div>
          <label className={styles.radiusLabel}><span>STUDY RADIUS <strong>{radius} m</strong></span><input type="range" min="100" max="500" step="100" value={radius} onChange={(event) => setRadius(Number(event.target.value))} /></label>
          <button className={styles.primaryButton} type="submit" disabled={busy || !validSite}>{busy ? 'Retrieving layers…' : 'Retrieve site layers'} <span>↗</span></button>
        </form>
        <p className={styles.status} role="status">{status}</p>
        <div className={styles.sectionTitle}><span>AVAILABLE CONTEXT</span><small>{collection ? `${collection.features.length} FEATURES` : 'NOT RETRIEVED'}</small></div>
        <div className={styles.layerRow}><span className={styles.layerGlyph}>▤</span><div><strong>Building footprints</strong><small>OpenStreetMap · contributor coverage</small></div><b>{collection ? buildings : '—'}</b></div>
        <div className={styles.layerRow}><span className={styles.layerGlyph}>≋</span><div><strong>Road network</strong><small>OpenStreetMap · contributor coverage</small></div><b>{collection ? roads : '—'}</b></div>
        <div className={styles.layerRow}><span className={styles.layerGlyph}>◌</span><div><strong>Study boundary</strong><small>Circle centered on selected point</small></div><b>{(Math.PI * radius * radius / 10_000).toFixed(1)} ha</b></div>
        <div className={styles.sectionTitle}><span>TAKE IT INTO CAD</span><small>LOCAL METRES</small></div>
        <div className={styles.exports}><button type="button" disabled={!collection || !validSite} onClick={() => collection && download('site-context.dxf', siteDxf(collection, lat, lon), 'application/dxf')}>DXF <span>↗</span></button><button type="button" disabled={!collection} onClick={() => collection && download('site-context.geojson', JSON.stringify(collection, null, 2), 'application/geo+json')}>GeoJSON <span>↗</span></button></div>
        <p className={styles.smallNote}>DXF origin is the selected site point. Keep these coordinates with your drawing; geometry is source data, not a survey.</p>
        <div className={styles.sectionTitle}><span>OPEN DATA DESK</span><small>INSPECT COVERAGE</small></div>
        <a className={styles.sourceRow} href="https://www.usgs.gov/tools/lidarexplorer" target="_blank" rel="noreferrer"><strong>Terrain & lidar · U.S.</strong><small>USGS 3DEP · inspect local acquisition date ↗</small></a>
        <a className={styles.sourceRow} href="https://esa-worldcover.org/en/data-access" target="_blank" rel="noreferrer"><strong>Land cover · global</strong><small>ESA WorldCover · 10 m, 2020–2021 ↗</small></a>
        <a className={styles.sourceRow} href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer"><strong>Buildings, roads & land use</strong><small>OpenStreetMap · license & source detail ↗</small></a>
      </>}
      {panel === 'history' && <>
        <div className={styles.panelHeader}><span className={styles.eyebrow}>PLACE & PEOPLE</span><h1>Read beyond the parcel.</h1><p>Search nearby records and track what the available sources cannot tell you.</p></div>
        <div className={styles.sectionTitle}><span>SITE HISTORY</span><small>NEARBY RECORDS</small></div><button className={styles.secondaryButton} type="button" onClick={loadHistory}>Search place records <span>↗</span></button><p className={styles.status} role="status">{historyStatus}</p>
        {history.map((item) => <a className={styles.sourceRow} key={item.pageid} href={`https://en.wikipedia.org/?curid=${item.pageid}`} target="_blank" rel="noreferrer"><strong>{item.title}</strong><small>{Math.round(item.dist)} m away · Wikipedia ↗</small></a>)}
        <div className={styles.sectionTitle}><span>PRIMARY SOURCES</span></div><a className={styles.sourceRow} href={`https://www.loc.gov/maps/?q=${encodeURIComponent(siteName)}`} target="_blank" rel="noreferrer"><strong>Historic maps</strong><small>Library of Congress ↗</small></a><a className={styles.sourceRow} href="https://earthexplorer.usgs.gov/" target="_blank" rel="noreferrer"><strong>Historic imagery</strong><small>USGS EarthExplorer ↗</small></a>
        <div className={styles.sectionTitle}><span>DEMOGRAPHICS</span></div><p className={styles.smallNote}>Population grids describe an area, not a parcel. Age, income, and housing measures need a local statistical source.</p><a className={styles.sourceRow} href="https://ghsl.jrc.ec.europa.eu/download.php" target="_blank" rel="noreferrer"><strong>Global population grid</strong><small>GHSL ↗</small></a><a className={styles.sourceRow} href="https://www.census.gov/data/developers/data-sets/acs-5year.html" target="_blank" rel="noreferrer"><strong>U.S. neighborhood data</strong><small>American Community Survey ↗</small></a>
        <div className={styles.sectionTitle}><span>MISSING SOMETHING?</span></div><button className={styles.secondaryButton} type="button" onClick={() => void loadCommunity()}>Show community records <span>↗</span></button><p className={styles.status} role="status">{communityStatus}</p>
        {community.map((record) => <article className={styles.communityRecord} key={record.id}><small>{record.kind} · {record.category} · {record.authorHandle}</small><strong>{record.title}</strong><p>{record.note}</p>{record.sourceUrl && <a href={record.sourceUrl} target="_blank" rel="noreferrer">Original source ↗</a>}<button type="button" onClick={() => void reportRecord(record.id)}>Report inaccurate</button></article>)}
        <form className={styles.contribute} onSubmit={(event) => void publishRecord(event)}><div className={styles.coordinates}><label>TYPE<select value={recordKind} onChange={(event) => setRecordKind(event.target.value as 'request' | 'source')}><option value="request">Request data</option><option value="source">Add source</option></select></label><label>CATEGORY<select value={recordCategory} onChange={(event) => setRecordCategory(event.target.value)}><option value="history">History</option><option value="demographics">Demographics</option><option value="terrain">Terrain</option><option value="other">Other</option></select></label></div><label>TITLE<input required minLength={8} maxLength={160} value={recordTitle} onChange={(event) => setRecordTitle(event.target.value)} /></label><label>CONTEXT<textarea maxLength={2000} value={recordNote} onChange={(event) => setRecordNote(event.target.value)} /></label>{recordKind === 'source' && <label>ORIGINAL SOURCE URL<input required type="url" pattern="https://.*" value={recordUrl} onChange={(event) => setRecordUrl(event.target.value)} /></label>}<button className={styles.primaryButton} type="submit">Publish record <span>↗</span></button></form>
      </>}
      {panel === 'design' && <>
        <div className={styles.panelHeader}><span className={styles.eyebrow}>DESIGN GEOMETRY</span><h1>Bring your proposal.</h1><p>GeoJSON draws on the map. Other files stay attached here until their location and scale can be verified.</p></div>
        <label className={styles.fileDrop}><span>＋</span><strong>Import geometry or a reference</strong><small>GeoJSON, glTF, Rhino, IFC, DXF, DWG, PDF</small><input type="file" accept=".geojson,.json,.glb,.gltf,.pdf,.dxf,.dwg,.3dm,.rvt,.ifc,.idf,.gbxml" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ''; }} /></label>
        <p className={styles.status} role="status">{status}</p>{files.map((file, index) => <div className={styles.layerRow} key={`${file.name}-${index}`}><span className={styles.layerGlyph}>◇</span><div><strong>{file.name}</strong><small>{file.kind.toUpperCase()} · {(file.size / 1024 / 1024).toFixed(1)} MB</small></div>{file.url && <a href={file.url} target="_blank" rel="noreferrer">↗</a>}</div>)}
        <div className={styles.sectionTitle}><span>PLACEMENT CHECK</span></div><p className={styles.smallNote}>Imported GeoJSON must use longitude and latitude coordinates. A CAD or 3D file needs a confirmed coordinate system, origin, units, and vertical datum before it can be placed responsibly.</p>
      </>}
      {panel === 'climate' && <>
        <div className={styles.panelHeader}><span className={styles.eyebrow}>ENVIRONMENT</span><h1>Study the light.</h1><p>A quick solar position for the selected site and time.</p></div>
        <label className={styles.dateField}>LOCAL STUDY DATE & TIME<input type="datetime-local" value={dateTime} onChange={(event) => setDateTime(event.target.value)} /></label>
        {sun && <div className={styles.sunReadout}><div><small>SOLAR ALTITUDE</small><strong>{sun.altitude.toFixed(1)}°</strong></div><div><small>AZIMUTH FROM NORTH</small><strong>{sun.azimuth.toFixed(1)}°</strong></div><div><small>HORIZON</small><strong>{sun.altitude > 0 ? 'Above' : 'Below'}</strong></div></div>}
        <p className={styles.smallNote}>Astronomical estimate using the browser’s local time zone. It does not include terrain, neighboring buildings, weather, or the site’s time zone.</p>
        <div className={styles.sectionTitle}><span>BUILDING ENERGY</span></div><p className={styles.smallNote}>Simulation needs a weather file, envelope, program, schedules, and systems. No energy result is presented until a real model runner is connected.</p><a className={styles.sourceRow} href="https://energyplus.net/" target="_blank" rel="noreferrer"><strong>EnergyPlus inputs & documentation</strong><small>Official project ↗</small></a>
      </>}
    </aside>

    <div className={styles.mapControls}><div className={styles.basemapSwitch} aria-label="Map appearance"><button type="button" aria-pressed={imagery === 'streets'} onClick={() => setImagery('streets')}>Streets</button><button type="button" aria-pressed={imagery === 'earth'} onClick={() => setImagery('earth')}>Earth</button>{google3DKey && <button type="button" aria-pressed={imagery === 'google'} onClick={() => setImagery('google')}>Google 3D</button>}</div><span className={styles.mapScale}>{imagery === 'google' ? 'GOOGLE MAPS 3D' : `OPEN GEOSPATIAL VIEW · ${imagery === 'earth' ? 'NASA BLUE MARBLE · 2004 COMPOSITE' : 'OSM BASEMAP'}`}</span></div>
  </main>;
}
