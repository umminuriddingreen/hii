// SPDX-License-Identifier: LicenseRef-BSL-1.1
'use client';

import { useState } from 'react';
import styles from './store.module.css';

type Manifest = { id: string; name: string; version: string; developer: string; summary: string; capabilities: string[]; surfaces: string[] };

function inspectManifest(input: unknown): Manifest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The file must contain one application manifest object.');
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1) throw new Error('HII currently supports application manifest schemaVersion 1.');
  const required = ['id', 'name', 'version', 'developer', 'summary', 'icon'] as const;
  for (const field of required) if (typeof value[field] !== 'string' || !(value[field] as string).trim()) throw new Error(`The manifest needs a ${field} field.`);
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(value.id as string)) throw new Error('The application ID must use 1–120 letters, numbers, periods, hyphens, or underscores.');
  if ((value.name as string).length > 100) throw new Error('The application name must be 100 characters or fewer.');
  if (!value.surfaces || typeof value.surfaces !== 'object' || Array.isArray(value.surfaces)) throw new Error('The manifest needs a surfaces object.');
  const declared = value.surfaces as Record<string, unknown>;
  const surfaces = ['canvas', 'native'].filter((key) => declared[key] !== undefined && declared[key] !== null);
  if (!surfaces.length) throw new Error('The manifest must declare a canvas or native surface.');
  if (declared.canvas !== undefined && declared.canvas !== null) {
    if (typeof declared.canvas !== 'object' || Array.isArray(declared.canvas)) throw new Error('Canvas surface must be an object.');
    const canvas = declared.canvas as Record<string, unknown>;
    if (typeof canvas.surface !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(canvas.surface)) throw new Error('Canvas surface needs a valid surface ID.');
    if (!Number.isInteger(canvas.width) || !Number.isInteger(canvas.height) || (canvas.width as number) < 240 || (canvas.width as number) > 4096 || (canvas.height as number) < 180 || (canvas.height as number) > 4096) throw new Error('Canvas dimensions must be between 240×180 and 4096×4096.');
    if (canvas.entryUrl !== undefined) {
      if (typeof canvas.entryUrl !== 'string') throw new Error('Canvas entryUrl must be a URL.');
      let url: URL;
      try { url = new URL(canvas.entryUrl); } catch { throw new Error('Canvas entryUrl must be an absolute URL.'); }
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))) throw new Error('Canvas entryUrl must use HTTPS or local HTTP.');
    }
  }
  if (declared.native !== undefined && declared.native !== null) {
    if (typeof declared.native !== 'object' || Array.isArray(declared.native)) throw new Error('Native surface must be an object.');
    const native = declared.native as Record<string, unknown>;
    if (typeof native.bundleIdentifier !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(native.bundleIdentifier)) throw new Error('Native surface needs a valid bundle identifier.');
  }
  if (value.capabilities !== undefined && (!Array.isArray(value.capabilities) || !value.capabilities.every((cap) => typeof cap === 'string'))) throw new Error('Capabilities must be a list of names.');
  return { id: value.id as string, name: value.name as string, version: value.version as string, developer: value.developer as string, summary: value.summary as string, capabilities: value.capabilities as string[] || [], surfaces };
}

export function CommunityManifest() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState('');
  const [filename, setFilename] = useState('manifest.json');

  async function onFile(file?: File) {
    setManifest(null);
    setError('');
    if (!file) return;
    if (file.size > 64 * 1024) { setError('Manifest is too large. The limit is 64 KB.'); return; }
    setFilename(file.name);
    try { setManifest(inspectManifest(JSON.parse(await file.text()))); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not read this manifest.'); }
  }

  return <div className={styles.inspector}>
    <div className={styles.inspectorHead}><span>Manifest inspector</span><span>LOCAL FILE · NO UPLOAD</span></div>
    <label className={styles.filePicker}><span className={styles.fileGlyph} aria-hidden="true">↥</span><strong>Choose an HII application manifest</strong><small>JSON · inspected in this browser · up to 64 KB</small><input type="file" accept=".json,application/json" onChange={(event) => onFile(event.target.files?.[0])} /></label>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {manifest ? <div className={styles.manifestFacts} role="status">
      <div><span>Application</span><strong>{manifest.name} <small>{manifest.version}</small></strong></div>
      <div><span>Developer claim</span><strong>{manifest.developer}</strong></div>
      <div><span>Identity</span><code>{manifest.id}</code></div>
      <div><span>Surfaces</span><strong>{manifest.surfaces.join(' · ')}</strong></div>
      <div><span>Requested capabilities</span><strong>{manifest.capabilities.length ? manifest.capabilities.join(', ') : 'None declared'}</strong></div>
      <p>{manifest.summary}</p>
      <div className={styles.registerSteps}><strong>Register on your computer</strong><code>hii apps register &lt;path-to-{filename.replace(/[^A-Za-z0-9_.-]/g, '')}&gt;</code><small>Registration records the manifest in HII. Obtain and install the developer’s application separately, then verify it runs before granting capabilities.</small></div>
    </div> : <p className={styles.inspectorFoot}>No file is uploaded. Publisher identity and package integrity are not verified by this inspector.</p>}
  </div>;
}
