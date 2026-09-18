'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type Candidate = { id: string; name: string; weightedScore: number; reason: string; scores: Record<string, number> };
type Family = { id: string; label: string; artists: string[]; traits: string[] };
type Photo = { id: string; filename: string; localImagePath?: string | null; artistFamilyIds: string[]; subjectTags: string[]; classificationStatus: string; gps: { directionDeg?: number | null } };
type Project = { title: string; concept: { statement: string }; selection: { candidateId: string; artistFamilyId: string; photoId: string }; candidates: Candidate[]; artistFamilies: Family[]; photos: Photo[]; files: { photoWalk: string; pdfOutput: string }; provenance: { locatedPhotoCount: number; classificationNote: string } };

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const api = await import('@tauri-apps/api/core');
  return api.invoke<T>(command, args);
}

export function NatirarProjectSurface() {
  const [project, setProject] = useState<Project | null>(null);
  const [status, setStatus] = useState('Opening local project…');
  const [imageUrl, setImageUrl] = useState('');
  const [subject, setSubject] = useState('all');
  const load = useCallback(async () => {
    try { setProject(await invoke<Project>('natirar_project_read')); setStatus('Local project linked'); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const family = project?.artistFamilies.find((item) => item.id === project.selection.artistFamilyId);
  const allFamilyPhotos = useMemo(() => project?.photos.filter((photo) => photo.artistFamilyIds.includes(project.selection.artistFamilyId)) || [], [project]);
  const subjects = useMemo(() => Array.from(new Set(allFamilyPhotos.flatMap((photo) => photo.subjectTags))).sort(), [allFamilyPhotos]);
  const photos = subject === 'all' ? allFamilyPhotos : allFamilyPhotos.filter((photo) => photo.subjectTags.includes(subject));
  const photo = project?.photos.find((item) => item.id === project.selection.photoId) || photos[0];
  useEffect(() => {
    if (!photo?.localImagePath) { setImageUrl(''); return; }
    void import('@tauri-apps/api/core').then(({ convertFileSrc }) => setImageUrl(convertFileSrc(photo.localImagePath!))).catch(() => setImageUrl(''));
  }, [photo?.localImagePath]);
  const select = async (next: Partial<Project['selection']>) => {
    if (!project) return;
    const selection = { ...project.selection, ...next };
    if (next.artistFamilyId) {
      const first = project.photos.find((item) => item.artistFamilyIds.includes(next.artistFamilyId!));
      if (first) selection.photoId = first.id;
      setSubject('all');
    }
    setProject({ ...project, selection });
    try {
      const result = await invoke<{ project: Project; receiptPath: string }>('natirar_project_select', { candidateId: selection.candidateId, artistFamilyId: selection.artistFamilyId, photoId: selection.photoId });
      setProject(result.project); setStatus(`Selection saved · ${result.receiptPath.split('/').pop()}`);
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };
  const rhino = async (action: string) => {
    setStatus(`${action.replaceAll('_', ' ')}…`);
    try {
      const result = await invoke<{ success: boolean; message: string }>('natirar_rhino_action', { action });
      setStatus(`${result.success ? 'Rhino linked' : 'Rhino refused'} · ${result.message}`);
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };
  if (!project) return <section className="natirar-project"><div className="natirar-empty"><b>NATIRAR / LOCAL PROJECT</b><p>{status}</p></div></section>;
  return <section className="natirar-project">
    <header><div><small>ARCH 495 / LIVE FIELD</small><h2>{project.title}</h2></div><p>{status}</p></header>
    <div className="natirar-grid">
      <aside><label>01 / ARTIST FIELD</label>{project.artistFamilies.map((item) => <button key={item.id} aria-pressed={item.id === family?.id} onClick={() => void select({ artistFamilyId: item.id })}><b>{item.label}</b><span>{item.artists.join(' · ')}</span></button>)}<label>SUBJECT</label><select value={subject} onChange={(event) => setSubject(event.target.value)}><option value="all">All subjects</option>{subjects.map((item) => <option key={item}>{item}</option>)}</select><p className="natirar-note">{project.provenance.locatedPhotoCount} geolocated views · classifications remain provisional.</p></aside>
      <main><label>02 / PLACEMENT MATRIX</label><div className="natirar-candidates">{project.candidates.map((item) => <button key={item.id} aria-pressed={item.id === project.selection.candidateId} onClick={() => void select({ candidateId: item.id })}><i>{item.id}</i><span><b>{item.name}</b><small>{item.reason}</small></span><strong>{Math.round(item.weightedScore*100)}</strong></button>)}</div><blockquote>{project.concept.statement}</blockquote><div className="natirar-actions"><button onClick={() => void rhino('ping')}>Test Rhino</button><button onClick={() => void rhino('build_study')}>Build all 5 in Rhino</button><button onClick={() => void rhino('open_grasshopper')}>Open Grasshopper</button><button onClick={() => void rhino('solve_grasshopper')}>Solve</button><button onClick={() => void rhino('undo')}>Undo build</button></div></main>
      <aside className="natirar-view"><label>03 / LOCKED VIEW</label><div className="natirar-photo">{imageUrl ? <img src={imageUrl} alt={photo?.filename || 'Selected site view'} /> : <span>Image catalogued on the PC source; local original not yet mirrored.</span>}<i>VIEW CONE</i></div><select value={photo?.id || ''} onChange={(event) => void select({ photoId: event.target.value })}>{photos.map((item) => <option key={item.id} value={item.id}>{item.filename}</option>)}</select><dl><div><dt>Artist family</dt><dd>{family?.label}</dd></div><div><dt>Artists</dt><dd>{family?.artists.join(' · ')}</dd></div><div><dt>Subjects</dt><dd>{photo?.subjectTags.join(' · ')}</dd></div><div><dt>Direction</dt><dd>{photo?.gps.directionDeg?.toFixed(1) || '—'}° true</dd></div></dl><a href={project.files.photoWalk} target="_blank" rel="noreferrer">Open recovered photo walk ↗</a></aside>
    </div>
  </section>;
}
