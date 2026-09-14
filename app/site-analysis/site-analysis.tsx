// SPDX-License-Identifier: LicenseRef-BSL-1.1
'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { osmXmlToGeoJSON, siteBounds, siteDxf, solarPosition, validGeoJSON, type SiteCollection } from '@/lib/site-analysis';
import styles from './site-analysis.module.css';

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
  const [tab, setTab] = useState<'context' | 'history' | 'design' | 'climate'>('context');
  const lat = Number(latitude);
  const lon = Number(longitude);
  const validSite = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 85 && Math.abs(lon) <= 180 && radius >= 100 && radius <= 500;
  const bounds = validSite ? siteBounds(lat, lon, radius) : null;
  const osmUrl = bounds ? `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent([bounds[1], bounds[0], bounds[3], bounds[2]].join(','))}&layer=mapnik&marker=${lat},${lon}` : '';
  const earthUrl = validSite ? `https://earth.google.com/web/search/${lat},${lon}` : '';
  const sun = useMemo(() => validSite && !Number.isNaN(new Date(dateTime).getTime()) ? solarPosition(new Date(dateTime), lat, lon) : null, [dateTime, lat, lon, validSite]);
  const buildings = collection?.features.filter((feature) => Boolean(feature.properties?.building)).length || 0;
  const roads = collection?.features.filter((feature) => Boolean(feature.properties?.highway)).length || 0;

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

  return <div className={styles.shell}>
    <header className={styles.header}><a href="/" className={styles.brand}>hii</a><div><small>HII / ARCHITECTURE</small><h1>Site analysis</h1></div><span className={styles.stage}>STUDENT WORKSPACE · EARLY ACCESS</span></header>
    <div className={styles.layout}>
      <aside className={styles.sidebar}>
        <div className={styles.block}><span className={styles.kicker}>01 / PLACE</span><label>Project name<input value={siteName} onChange={(event) => setSiteName(event.target.value)} maxLength={80} /></label>
          <form onSubmit={retrieve} className={styles.form}><div className={styles.two}><label>Latitude<input type="number" step="any" value={latitude} onChange={(event) => setLatitude(event.target.value)} /></label><label>Longitude<input type="number" step="any" value={longitude} onChange={(event) => setLongitude(event.target.value)} /></label></div><label>Context radius <strong>{radius} m</strong><input type="range" min="100" max="500" step="100" value={radius} onChange={(event) => setRadius(Number(event.target.value))} /></label><button type="submit" disabled={busy || !validSite}>{busy ? 'retrieving…' : 'retrieve site context'}</button></form><p className={styles.status} role="status">{status}</p></div>
        <div className={styles.block}><span className={styles.kicker}>02 / LAYERS</span><div className={styles.stat}><span>Buildings</span><strong>{buildings}</strong></div><div className={styles.stat}><span>Roads</span><strong>{roads}</strong></div><div className={styles.stat}><span>Area of interest</span><strong>{(Math.PI * radius * radius / 10_000).toFixed(1)} ha</strong></div><small>Counts reflect retrieved or imported geometry, not surveyed conditions.</small></div>
        <div className={styles.block}><span className={styles.kicker}>03 / EXPORT</span><button type="button" disabled={!collection} onClick={() => collection && download('site-context.geojson', JSON.stringify(collection, null, 2), 'application/geo+json')}>download GeoJSON</button><button type="button" disabled={!collection || !validSite} onClick={() => collection && download('site-context.dxf', siteDxf(collection, lat, lon), 'application/dxf')}>download DXF</button><small>DXF is in local metres, with the entered site point as origin. Keep the coordinate note with the drawing.</small></div>
      </aside>
      <section className={styles.main}>
        <nav className={styles.tabs} aria-label="Site analysis views">{(['context', 'history', 'design', 'climate'] as const).map((item) => <button type="button" key={item} className={tab === item ? styles.active : ''} onClick={() => setTab(item)}>{item}</button>)}</nav>
        {tab === 'context' && <><div className={styles.mapHead}><div><small>LIVE BASE MAP</small><h2>{siteName || 'Untitled site'}</h2><span>{validSite ? `${lat.toFixed(5)}°, ${lon.toFixed(5)}°` : 'Set valid coordinates'}</span></div><a href={earthUrl || '#'} target="_blank" rel="noreferrer" aria-disabled={!validSite}>open in Google Earth ↗</a></div><div className={styles.map}>{osmUrl ? <iframe title="OpenStreetMap site preview" src={osmUrl} loading="lazy" /> : <p>Enter a valid site location.</p>}</div><p className={styles.attribution}>Map © OpenStreetMap contributors. Downloadable features come from OpenStreetMap, not Google imagery. <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">License ↗</a></p><div className={styles.cards}><article><small>SOURCE</small><h3>OpenStreetMap</h3><p>Roads, footprints, land use, and waterways where contributors have mapped them.</p><a href="https://www.openstreetmap.org" target="_blank" rel="noreferrer">inspect source ↗</a></article><article><small>NEXT STEP</small><h3>Bring your survey</h3><p>Import a georeferenced GeoJSON file to replace or supplement retrieved context.</p></article></div></>}
        {tab === 'history' && <div className={styles.panel}><span className={styles.kicker}>SITE HISTORY / DEMOGRAPHICS</span><h2>What was here, and who lives around it?</h2><p>Sources vary around the world. Each record should be read with its date, geography, and original citation.</p><div className={styles.cards}><article><small>HISTORY</small><h3>Nearby place records</h3><button type="button" onClick={loadHistory}>find nearby records</button><p role="status">{historyStatus}</p>{history.map((item) => <a className={styles.result} key={item.pageid} href={`https://en.wikipedia.org/?curid=${item.pageid}`} target="_blank" rel="noreferrer">{item.title}<small>{Math.round(item.dist)} m away ↗</small></a>)}</article><article><small>ARCHIVES</small><h3>Historic maps and imagery</h3><p>Search collections by place and date; inspect rights before adding imagery to a presentation.</p><a href={`https://www.loc.gov/maps/?q=${encodeURIComponent(siteName)}`} target="_blank" rel="noreferrer">Library of Congress maps ↗</a><a href="https://earthexplorer.usgs.gov/" target="_blank" rel="noreferrer">USGS EarthExplorer ↗</a><a href="https://commons.wikimedia.org/wiki/Special:MediaSearch" target="_blank" rel="noreferrer">Wikimedia Commons ↗</a></article><article><small>DEMOGRAPHICS</small><h3>Coverage-aware data</h3><p>Global population grids are available through GHSL. Age, income, and housing measures require country or local statistical sources and cannot be inferred from a parcel.</p><a href="https://ghsl.jrc.ec.europa.eu/download.php" target="_blank" rel="noreferrer">GHSL population data ↗</a><a href="https://www.census.gov/data/developers/data-sets/acs-5year.html" target="_blank" rel="noreferrer">U.S. ACS data ↗</a></article></div><section className={styles.community}><div><span className={styles.kicker}>COMMUNITY SOURCES</span><h3>Ask for missing data or add a source</h3><p>Public contributions are account-attributed and community supplied. Check original sources before citing them.</p><button type="button" onClick={() => void loadCommunity()}>show nearby records</button><p role="status">{communityStatus}</p>{community.map((record) => <article key={record.id}><small>{record.kind} · {record.category} · {record.authorHandle} · {new Date(record.createdAt).toLocaleDateString()}</small><strong>{record.title}</strong><p>{record.note}</p>{record.sourceUrl && <a href={record.sourceUrl} target="_blank" rel="noreferrer">original source ↗</a>}<button type="button" onClick={() => void reportRecord(record.id)}>report inaccurate</button></article>)}</div><form onSubmit={(event) => void publishRecord(event)}><label>Type<select value={recordKind} onChange={(event) => setRecordKind(event.target.value as 'request' | 'source')}><option value="request">request data</option><option value="source">contribute source</option></select></label><label>Category<select value={recordCategory} onChange={(event) => setRecordCategory(event.target.value)}><option value="history">history</option><option value="demographics">demographics</option><option value="terrain">terrain</option><option value="other">other</option></select></label><label>Title<input required minLength={8} maxLength={160} value={recordTitle} onChange={(event) => setRecordTitle(event.target.value)} /></label><label>Context<textarea maxLength={2000} value={recordNote} onChange={(event) => setRecordNote(event.target.value)} /></label>{recordKind === 'source' && <label>Original source URL<input required type="url" pattern="https://.*" value={recordUrl} onChange={(event) => setRecordUrl(event.target.value)} /></label>}<button type="submit">publish community record</button></form></section></div>}
        {tab === 'design' && <div className={styles.panel}><span className={styles.kicker}>DESIGN GEOMETRY</span><h2>Bring the proposal into the site.</h2><p>Attach a model or drawing. GeoJSON loads as mapped context. Other formats remain local reference files until a georeferencing and conversion job is available.</p><label className={styles.drop}>Choose a file<input type="file" accept=".geojson,.json,.glb,.gltf,.pdf,.dxf,.dwg,.3dm,.rvt,.ifc,.idf,.gbxml" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ''; }} /></label><div className={styles.fileList}>{files.map((file, index) => <div key={`${file.name}-${index}`}><strong>{file.name}</strong><small>{file.kind.toUpperCase()} · {(file.size / 1024 / 1024).toFixed(1)} MB</small>{file.url && <a href={file.url} target="_blank" rel="noreferrer">open reference ↗</a>}</div>)}</div><div className={styles.notice}><strong>3D preview setup</strong><p>Geolocated Google 3D model overlays require a Maps API key, hosted glTF asset, and confirmed scale and placement. The live Google Earth link above opens this site; uploaded models are not placed there yet.</p></div></div>}
        {tab === 'climate' && <div className={styles.panel}><span className={styles.kicker}>SOLAR / ENERGY</span><h2>Check the sun before committing to a form.</h2><label className={styles.date}>Local study date and time<input type="datetime-local" value={dateTime} onChange={(event) => setDateTime(event.target.value)} /></label>{sun && <div className={styles.sun}><div><small>SOLAR ALTITUDE</small><strong>{sun.altitude.toFixed(1)}°</strong></div><div><small>AZIMUTH FROM NORTH</small><strong>{sun.azimuth.toFixed(1)}°</strong></div><div><small>HORIZON</small><strong>{sun.altitude > 0 ? 'above' : 'below'}</strong></div></div>}<p>Sun angle is an astronomical estimate for the entered site and the browser’s local time zone. It does not account for terrain, neighboring buildings, weather, or daylight saving at the site.</p><div className={styles.notice}><strong>Full building simulation</strong><p>EnergyPlus runs require a weather file plus envelope, program, schedules, and systems inputs, or an existing energy model. No simulation result is shown until a real local or hosted runner is connected.</p><a href="https://energyplus.net/" target="_blank" rel="noreferrer">EnergyPlus documentation ↗</a></div></div>}
      </section>
    </div>
  </div>;
}
