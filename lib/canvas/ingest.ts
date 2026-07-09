import type { CanvasNode, CanvasNodeType } from './types';

export type NodeSeed = {
  type: CanvasNodeType;
  w: number;
  h: number;
  payload: Record<string, unknown>;
};

const CODE =
  /\.(m?[jt]sx?|svelte|vue|py|rb|go|rs|c|h|cpp|hpp|cs|java|kt|swift|sh|zsh|fish|sql|html?|css|scss|less|json[c5]?|ya?ml|toml|xml|md|markdown|txt|csv|tsv|log|env|ini|conf|lock|gitignore)$/i;
const FONT = /\.(ttf|otf|woff2?)$/i;
const IMG_URL = /\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i;

export const defaultSize: Record<CanvasNodeType, { w: number; h: number }> = {
  note: { w: 280, h: 200 },
  text: { w: 440, h: 320 },
  link: { w: 340, h: 96 },
  file: { w: 280, h: 92 },
  image: { w: 380, h: 300 },
  media: { w: 420, h: 300 },
  html: { w: 480, h: 360 },
  font: { w: 440, h: 170 },
  terminal: { w: 680, h: 440 },
  browser: { w: 760, h: 540 },
  context: { w: 360, h: 440 },
  board: { w: 360, h: 440 },
  job: { w: 360, h: 300 }
};

export function makeNode(seed: NodeSeed, x: number, y: number, z: number): CanvasNode {
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
    payload: seed.payload
  };
}

export function seedFor(type: CanvasNodeType, payload: Record<string, unknown> = {}): NodeSeed {
  return { type, ...defaultSize[type], payload };
}

function emojiFor(name: string, mime: string) {
  if (/\.(glb|gltf|obj|stl|fbx|usdz|blend)$/i.test(name)) return '🧊';
  if (/\.(zip|tar|gz|rar|7z|dmg|pkg)$/i.test(name)) return '🗜️';
  if (/\.(sketch|fig|psd|ai)$/i.test(name)) return '🎨';
  if (mime.startsWith('application/')) return '📦';
  return '📄';
}

export async function seedFromFile(file: File): Promise<NodeSeed> {
  const name = file.name || 'untitled';
  const t = file.type || '';
  if (t.startsWith('image/')) {
    return seedFor('image', { url: URL.createObjectURL(file), name, ephemeral: true });
  }
  if (t.startsWith('video/') || t.startsWith('audio/') || t === 'application/pdf') {
    const kind = t === 'application/pdf' ? 'pdf' : t.split('/')[0];
    return seedFor('media', { url: URL.createObjectURL(file), name, kind, ephemeral: true });
  }
  if (FONT.test(name)) {
    const fam = 'f' + Math.random().toString(36).slice(2);
    const face = new FontFace(fam, await file.arrayBuffer());
    await face.load();
    document.fonts.add(face);
    return seedFor('font', { fam, name, ephemeral: true });
  }
  if (t.startsWith('text/') || CODE.test(name) || /json|xml|javascript/.test(t)) {
    const content = await file.slice(0, 100_000).text();
    return seedFor('text', { content, name });
  }
  return seedFor('file', { name, size: file.size, mime: t, emoji: emojiFor(name, t) });
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
