import type { SpatialObjectMetadata, WorkspaceNode, WorkspaceNodeType } from './types';

export type NodeSeed = {
  type: WorkspaceNodeType;
  w: number;
  h: number;
  object?: SpatialObjectMetadata;
  payload: Record<string, unknown>;
};

const CODE =
  /\.(m?[jt]sx?|svelte|vue|py|rb|go|rs|c|h|cpp|hpp|cs|java|kt|swift|sh|zsh|fish|sql|html?|css|scss|less|json[c5]?|ya?ml|toml|xml|md|markdown|txt|csv|tsv|log|env|ini|conf|lock|gitignore)$/i;
const FONT = /\.(ttf|otf|woff2?)$/i;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|heic|heif)$/i;
const AUDIO_FILE = /\.(mp3|wav|aiff?|aac|m4a|flac|ogg|oga|opus|weba)$/i;
const VIDEO_FILE = /\.(mp4|m4v|mov|webm|ogv|avi|mkv)$/i;
const PDF_FILE = /\.pdf$/i;
const IMG_URL = /\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i;
const ARCHIVE = /\.(zip|tar|tgz|tar\.gz|rar|7z|gz|bz2|xz|dmg|pkg)$/i;
const DESIGN = /\.(fig|sketch|psd|psb|ai|ait|eps|indd|idml|xd|afdesign|afphoto|afpub|kra)$/i;
const MODEL_3D = /\.(glb|gltf|obj|stl|fbx|usdz|usd|usdc|dae|blend|3ds|ply)$/i;
const CAD = /\.(3dm|dwg|dxf|step|stp|iges|igs|ifc|sat|skp|rvt|3mf)$/i;

export const defaultSize: Record<WorkspaceNodeType, { w: number; h: number }> = {
  chat: { w: 420, h: 560 },
  note: { w: 280, h: 200 },
  text: { w: 440, h: 320 },
  'canvas-text': { w: 280, h: 96 },
  ink: { w: 140, h: 80 },
  link: { w: 340, h: 96 },
  file: { w: 280, h: 92 },
  image: { w: 380, h: 300 },
  media: { w: 420, h: 300 },
  html: { w: 480, h: 360 },
  font: { w: 440, h: 170 },
  terminal: { w: 680, h: 440 },
  browser: { w: 760, h: 540 },
  explorer: { w: 1040, h: 640 },
  context: { w: 360, h: 440 },
  board: { w: 360, h: 440 },
  surface: { w: 1080, h: 720 },
  job: { w: 360, h: 300 },
  'sound-field': { w: 820, h: 600 }
};

export function makeNode(seed: NodeSeed, x: number, y: number, z: number): WorkspaceNode {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    type: seed.type,
    x,
    y,
    w: seed.w,
    h: seed.h,
    z,
    createdAt: now,
    updatedAt: now,
    object: seed.object,
    payload: seed.payload
  };
}

export function seedFor(type: WorkspaceNodeType, payload: Record<string, unknown> = {}): NodeSeed {
  if (type === 'explorer') {
    return {
      type,
      ...defaultSize[type],
      object: {
        kind: 'interface',
        owner: 'hii',
        status: 'ready',
        source: 'HII workspace operator-created exploration window',
        audit: [
          {
            ts: new Date().toISOString(),
            actor: 'human',
            action: 'opened browser and terminal exploration window'
          }
        ]
      },
      payload: {
        title: 'live exploration',
        url: 'https://duckduckgo.com',
        sessionId: crypto.randomUUID(),
        ...payload
      }
    };
  }
  if (type === 'surface') {
    return {
      type,
      ...defaultSize[type],
      object: {
        kind: 'interface',
        owner: 'hii',
        status: 'ready',
        source: 'HII Desk governed surface',
        capabilityId: typeof payload.capabilityId === 'string' ? payload.capabilityId : undefined,
        audit: [
          {
            ts: new Date().toISOString(),
            actor: 'human',
            action: 'opened HII surface on Desk'
          }
        ]
      },
      payload
    };
  }
  if (type === 'sound-field') {
    return {
      type,
      ...defaultSize[type],
      object: {
        kind: 'scene',
        owner: 'hii',
        status: 'ready',
        source: 'modeled South Berkeley sound scenario',
        capabilityId: 'hii.scene.sound-field',
        proofRefs: ['City of Berkeley Open Data Portal checked; no continuous municipal sound sensor feed found'],
        audit: [
          {
            ts: new Date().toISOString(),
            actor: 'human',
            action: 'created sound-field object',
            note: 'Modeled values only; replace with calibrated measurements before analytical use.'
          }
        ]
      },
      payload: {
        title: 'South Berkeley Sound Field',
        dataMode: 'modeled',
        scenario: 'weekday',
        hour: 18,
        ...payload
      }
    };
  }
  return { type, ...defaultSize[type], payload };
}

export type StoredWorkspaceAsset = {
  name: string;
  mime: string;
  size: number;
  path: string;
  url: string;
};

export async function storeWorkspaceAsset(file: File): Promise<StoredWorkspaceAsset | null> {
  try {
    const form = new FormData();
    form.set('file', file, file.name || 'pasted-media');
    const response = await fetch('/api/workspace/assets', { method: 'POST', body: form });
    if (!response.ok) return null;
    const asset = (await response.json()) as Partial<StoredWorkspaceAsset>;
    if (!asset.url || !asset.path || !asset.name) return null;
    return {
      name: asset.name,
      mime: asset.mime || file.type,
      size: Number(asset.size ?? file.size),
      path: asset.path,
      url: asset.url
    };
  } catch {
    return null;
  }
}

function extensionFor(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.gz')) return 'tar.gz';
  const match = lower.match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function fileSummary(name: string, mime: string) {
  const extension = extensionFor(name);
  if (MODEL_3D.test(name)) {
    return { category: '3d model', emoji: '🧊', label: '3D asset', description: 'Preview not embedded; metadata only.' };
  }
  if (CAD.test(name)) {
    return { category: 'cad', emoji: '📐', label: 'CAD / BIM asset', description: 'Preview not embedded; metadata only.' };
  }
  if (DESIGN.test(name)) {
    return { category: 'design', emoji: '🎨', label: 'Design source', description: 'Preview not embedded; metadata only.' };
  }
  if (ARCHIVE.test(name)) {
    return { category: 'archive', emoji: '🗜️', label: 'Archive/package', description: 'Contents not unpacked or saved.' };
  }
  if (/spreadsheet|excel|sheet/i.test(mime) || /\.(xlsx?|numbers|ods)$/i.test(name)) {
    return { category: 'spreadsheet', emoji: '▦', label: 'Spreadsheet', description: 'Preview not embedded; metadata only.' };
  }
  if (/presentation|powerpoint|keynote/i.test(mime) || /\.(pptx?|key)$/i.test(name)) {
    return { category: 'presentation', emoji: '▣', label: 'Presentation', description: 'Preview not embedded; metadata only.' };
  }
  if (/word|document/i.test(mime) || /\.(docx?|pages|rtf)$/i.test(name)) {
    return { category: 'document', emoji: '▤', label: 'Document', description: 'Preview not embedded; metadata only.' };
  }
  if (mime.startsWith('application/')) {
    return { category: 'application', emoji: '📦', label: 'Application file', description: 'Preview not embedded; metadata only.' };
  }
  return { category: extension || 'file', emoji: '📄', label: extension ? `${extension.toUpperCase()} file` : 'File', description: 'Preview not embedded; metadata only.' };
}

export async function seedFromFile(file: File): Promise<NodeSeed> {
  const name = file.name || 'untitled';
  const t = file.type || '';
  const extension = extensionFor(name);
  if (t.startsWith('image/') || IMAGE_FILE.test(name)) {
    const stored = await storeWorkspaceAsset(file);
    const asset = stored
      ? { url: stored.url, path: stored.path, name: stored.name, mime: stored.mime, size: stored.size }
      : { url: URL.createObjectURL(file), name, mime: t, size: file.size, ephemeral: true };
    return seedFor('image', { ...asset, extension });
  }
  if (t.startsWith('video/') || VIDEO_FILE.test(name) || t.startsWith('audio/') || AUDIO_FILE.test(name) || t === 'application/pdf' || PDF_FILE.test(name)) {
    const stored = await storeWorkspaceAsset(file);
    const asset = stored
      ? { url: stored.url, path: stored.path, name: stored.name, mime: stored.mime, size: stored.size }
      : { url: URL.createObjectURL(file), name, mime: t, size: file.size, ephemeral: true };
    const kind = t === 'application/pdf' || PDF_FILE.test(name) ? 'pdf' : t.startsWith('audio/') || AUDIO_FILE.test(name) ? 'audio' : 'video';
    const size = kind === 'audio' ? { w: 420, h: 132 } : kind === 'pdf' ? { w: 520, h: 420 } : { w: 480, h: 320 };
    return { ...seedFor('media', { ...asset, kind, extension }), ...size };
  }
  if (FONT.test(name)) {
    const fam = 'f' + Math.random().toString(36).slice(2);
    const face = new FontFace(fam, await file.arrayBuffer());
    await face.load();
    document.fonts.add(face);
    return seedFor('font', { fam, name, mime: t, size: file.size, extension, ephemeral: true });
  }
  if (t.startsWith('text/') || CODE.test(name) || /json|xml|javascript/.test(t)) {
    const content = await file.slice(0, 100_000).text();
    return seedFor('text', { content, name, mime: t, size: file.size, extension, truncated: file.size > 100_000 });
  }
  return seedFor('file', { name, size: file.size, mime: t, extension, metadataOnly: true, ...fileSummary(name, t) });
}

export function seedFromUrl(u: string, html = ''): NodeSeed {
  const m = html && html.match(/<img[^>]+src="([^"]+)"/i);
  if (m) return seedFor('image', { url: m[1], name: u.split('/').pop() || u });
  if (IMG_URL.test(u)) return seedFor('image', { url: u, name: u.split('/').pop() ?? u });
  let host = '';
  try {
    host = new URL(u).hostname;
  } catch {
    /* keep card without host */
  }
  return seedFor('link', { url: u, host, name: host || 'link' });
}

export function seedFromString(text: string): NodeSeed {
  const t = text.trim();
  if (/^https?:\/\/\S+$/.test(t)) return seedFromUrl(t);
  if (/^<[a-z!]/i.test(t)) return seedFor('html', { srcdoc: text, name: 'html snippet' });
  return seedFor('text', { content: text.slice(0, 100_000), name: 'text' });
}

export async function seedsFromDataTransfer(dt: DataTransfer): Promise<NodeSeed[]> {
  const files = [...dt.files];
  if (files.length) return Promise.all(files.map((file) => seedFromFile(file)));
  const uris = dt
    .getData('text/uri-list')
    .split('\n')
    .filter((line) => line && !line.startsWith('#'));
  const html = dt.getData('text/html');
  const text = dt.getData('text/plain');
  if (uris.length) return uris.map((u) => seedFromUrl(u, html));
  if (html) return [seedFor('html', { srcdoc: html, name: 'html snippet' })];
  if (text) return [seedFromString(text)];
  return [];
}
