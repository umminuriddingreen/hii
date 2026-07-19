import { createHash, randomUUID } from 'node:crypto';
import fs, { type FSWatcher } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDocument } from 'yaml';

export type VaultConfig = {
  schemaVersion: 1;
  root: string;
  assetPolicy: 'copy-or-link';
  projectMode: 'single-vault';
  updatedAt: string;
};

export type VaultNote = {
  id: string;
  title: string;
  path: string;
  folder: string;
  content: string;
  pinned: boolean;
  dailyDate: string | null;
  kind: string;
  projectId: string;
  aliases: string[];
  createdAt: string;
  updatedAt: string;
  revision: string;
};

export type KnowledgeAsset = {
  id: string;
  projectId: string;
  name: string;
  mode: 'copy' | 'link';
  path: string;
  sourcePath: string;
  mime: string;
  size: number;
  contentHash: string;
  available: boolean;
  annotations: string;
  createdAt: string;
  updatedAt: string;
};

type AssetStore = { schemaVersion: 1; assets: KnowledgeAsset[] };

const watchers = new Map<string, FSWatcher>();
const revisions = new Map<string, number>();

function runtimeDir() {
  return process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii');
}

function configPath() {
  return path.join(runtimeDir(), 'knowledge', 'vault-config.json');
}

function expandHome(value: string) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function atomicWrite(file: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function validateRoot(input: string) {
  const resolved = path.resolve(expandHome(input.trim()));
  if (!path.isAbsolute(resolved)) throw new Error('Vault path must be absolute.');
  if (resolved === path.parse(resolved).root || resolved === os.homedir()) {
    throw new Error('Choose a dedicated folder, not the filesystem or home directory.');
  }
  if (resolved === path.join(runtimeDir(), 'vault.json')) {
    throw new Error('The encrypted HII secrets vault can never be used as knowledge storage.');
  }
  return resolved;
}

export function knowledgeVaultPath() {
  if (process.env.HII_VAULT_PATH) return validateRoot(process.env.HII_VAULT_PATH);
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Partial<VaultConfig>;
    if (typeof parsed.root === 'string') return validateRoot(parsed.root);
  } catch {
    // HII-owned files stay under the knowledge runtime; imported source vaults are never mutated.
  }
  return path.join(runtimeDir(), 'knowledge');
}

export function configureKnowledgeVault(root: unknown): VaultConfig {
  const nextRoot = validateRoot(String(root ?? ''));
  const config: VaultConfig = {
    schemaVersion: 1,
    root: nextRoot,
    assetPolicy: 'copy-or-link',
    projectMode: 'single-vault',
    updatedAt: new Date().toISOString()
  };
  atomicWrite(configPath(), `${JSON.stringify(config, null, 2)}\n`);
  ensureKnowledgeVault(nextRoot);
  startVaultWatcher(nextRoot);
  return config;
}

export function ensureKnowledgeVault(root = knowledgeVaultPath()) {
  const safeRoot = validateRoot(root);
  for (const relative of ['Inbox', 'Daily', 'Projects', 'Shared', 'Templates', 'Archive', '.hii', '.hii/views', '.trash']) {
    fs.mkdirSync(path.join(safeRoot, relative), { recursive: true });
  }
  const marker = path.join(safeRoot, '.hii', 'vault.json');
  if (!fs.existsSync(marker)) {
    atomicWrite(marker, `${JSON.stringify({ schemaVersion: 1, kind: 'hii.knowledge.vault', createdAt: new Date().toISOString() }, null, 2)}\n`);
  }
  startVaultWatcher(safeRoot);
  return safeRoot;
}

export function safeVaultRelativePath(value: unknown) {
  const supplied = String(value ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = supplied
    .split('/')
    .filter((part) => part && part !== '.')
    .map((part) => {
      if (part === '..') throw new Error('Vault paths cannot escape the approved root.');
      return part.replace(/[<>:"|?*\u0000-\u001F]/g, '-').trim();
    })
    .filter(Boolean);
  if (!parts.length) throw new Error('A vault-relative path is required.');
  return parts.join('/');
}

export function vaultAbsolute(relative: unknown, root = knowledgeVaultPath()) {
  const safeRoot = ensureKnowledgeVault(root);
  const target = path.resolve(safeRoot, safeVaultRelativePath(relative));
  if (target !== safeRoot && !target.startsWith(`${safeRoot}${path.sep}`)) throw new Error('Path escapes the approved vault root.');
  return target;
}

export function parseVaultMarkdown(raw: string) {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { metadata: {} as Record<string, unknown>, content: normalized, frontmatter: '' };
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) return { metadata: {} as Record<string, unknown>, content: normalized, frontmatter: '' };
  const frontmatter = normalized.slice(4, end);
  const parsed = parseDocument(frontmatter, { keepSourceTokens: true }).toJS();
  const metadata = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  return { metadata, content: normalized.slice(end + 5), frontmatter };
}

function yamlValue(value: unknown) {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

function serializeVaultNote(note: Omit<VaultNote, 'revision'>) {
  const metadata: Record<string, unknown> = {
    hii_id: note.id,
    hii_kind: note.kind || 'note',
    project: note.projectId || 'shared',
    title: note.title,
    pinned: note.pinned,
    aliases: note.aliases,
    daily_date: note.dailyDate,
    created_at: note.createdAt,
    updated_at: note.updatedAt
  };
  const frontmatter = Object.entries(metadata).map(([key, value]) => `${key}: ${yamlValue(value)}`).join('\n');
  return `---\n${frontmatter}\n---\n${note.content.replace(/^\n+/, '')}`;
}

function noteRevision(raw: string) {
  return createHash('sha256').update(raw).digest('hex');
}

function projectFromPath(relative: string, fallback = 'shared') {
  const match = relative.match(/^Projects\/([^/]+)/i);
  return match?.[1] || fallback;
}

function deterministicNoteId(relative: string) {
  return `note-${createHash('sha256').update(relative.normalize('NFC').toLowerCase()).digest('hex').slice(0, 32)}`;
}

export function readVaultNote(relative: string, root = knowledgeVaultPath()): VaultNote {
  const safePath = safeVaultRelativePath(relative);
  const absolute = vaultAbsolute(safePath, root);
  const raw = fs.readFileSync(absolute, 'utf8');
  const stat = fs.statSync(absolute);
  const { metadata, content } = parseVaultMarkdown(raw);
  const createdAt = typeof metadata.created_at === 'string' ? metadata.created_at : stat.birthtime.toISOString();
  const metadataUpdatedAt = typeof metadata.updated_at === 'string' ? new Date(metadata.updated_at).getTime() : 0;
  const updatedAt = new Date(Math.max(Number.isFinite(metadataUpdatedAt) ? metadataUpdatedAt : 0, stat.mtimeMs)).toISOString();
  const title = typeof metadata.title === 'string' && metadata.title.trim()
    ? metadata.title.trim()
    : path.basename(safePath, path.extname(safePath));
  return {
    id: typeof metadata.hii_id === 'string' && metadata.hii_id
      ? metadata.hii_id
      : typeof metadata.id === 'string' && metadata.id
        ? metadata.id
        : deterministicNoteId(safePath),
    title,
    path: safePath,
    folder: path.posix.dirname(safePath) === '.' ? '' : path.posix.dirname(safePath),
    content,
    pinned: metadata.pinned === true,
    dailyDate: typeof metadata.daily_date === 'string' ? metadata.daily_date : null,
    kind: typeof metadata.hii_kind === 'string' ? metadata.hii_kind : 'note',
    projectId: typeof metadata.project === 'string' ? metadata.project : projectFromPath(safePath),
    aliases: Array.isArray(metadata.aliases) ? metadata.aliases.map(String).slice(0, 50) : [],
    createdAt,
    updatedAt,
    revision: noteRevision(raw)
  };
}

export function writeVaultNote(note: Omit<VaultNote, 'revision'>, previousPath?: string, root = knowledgeVaultPath()) {
  const safeRoot = ensureKnowledgeVault(root);
  const safePath = safeVaultRelativePath(note.path);
  if (!/\.md$/i.test(safePath)) throw new Error('Knowledge notes must use a .md extension.');
  const target = vaultAbsolute(safePath, safeRoot);
  const serialized = serializeVaultNote({ ...note, path: safePath });
  atomicWrite(target, serialized);
  if (previousPath && safeVaultRelativePath(previousPath) !== safePath) {
    const previous = vaultAbsolute(previousPath, safeRoot);
    if (fs.existsSync(previous) && previous !== target) fs.rmSync(previous);
  }
  return readVaultNote(safePath, safeRoot);
}

function walkMarkdown(directory: string, root: string, output: string[]) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.name === '.hii' || entry.name === '.trash' || entry.name === '.git') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walkMarkdown(absolute, root, output);
    else if (entry.isFile() && /\.md$/i.test(entry.name)) output.push(path.relative(root, absolute).split(path.sep).join('/'));
  }
}

export function scanVaultNotes(root = knowledgeVaultPath()) {
  const safeRoot = ensureKnowledgeVault(root);
  const paths: string[] = [];
  walkMarkdown(safeRoot, safeRoot, paths);
  return paths.sort((a, b) => a.localeCompare(b)).map((relative) => readVaultNote(relative, safeRoot));
}

export function trashVaultNote(note: Pick<VaultNote, 'id' | 'path'>, root = knowledgeVaultPath()) {
  const safeRoot = ensureKnowledgeVault(root);
  const source = vaultAbsolute(note.path, safeRoot);
  if (!fs.existsSync(source)) throw new Error(`Vault note not found: ${note.path}`);
  const target = path.join(safeRoot, '.trash', `${note.id}--${path.basename(note.path)}`);
  fs.renameSync(source, target);
  return target;
}

export function restoreVaultNote(note: Pick<VaultNote, 'id' | 'path'>, root = knowledgeVaultPath()) {
  const safeRoot = ensureKnowledgeVault(root);
  const prefix = `${note.id}--`;
  const match = fs.readdirSync(path.join(safeRoot, '.trash')).find((name) => name.startsWith(prefix));
  if (!match) throw new Error(`Trashed vault note not found: ${note.id}`);
  const target = vaultAbsolute(note.path, safeRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(path.join(safeRoot, '.trash', match), target);
  return readVaultNote(note.path, safeRoot);
}

function assetStorePath(root = knowledgeVaultPath()) {
  return path.join(ensureKnowledgeVault(root), '.hii', 'assets.json');
}

function readAssetStore(root = knowledgeVaultPath()): AssetStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(assetStorePath(root), 'utf8')) as AssetStore;
    return { schemaVersion: 1, assets: Array.isArray(parsed.assets) ? parsed.assets : [] };
  } catch {
    return { schemaVersion: 1, assets: [] };
  }
}

function writeAssetStore(store: AssetStore, root = knowledgeVaultPath()) {
  atomicWrite(assetStorePath(root), `${JSON.stringify(store, null, 2)}\n`);
}

function hashFile(file: string) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function cleanAssetName(value: unknown) {
  return path.basename(String(value || 'asset')).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').slice(0, 240) || 'asset';
}

function uniqueAssetPath(relative: string, root: string) {
  const extension = path.posix.extname(relative);
  const stem = extension ? relative.slice(0, -extension.length) : relative;
  let candidate = relative;
  let index = 2;
  while (fs.existsSync(vaultAbsolute(candidate, root))) candidate = `${stem} ${index++}${extension}`;
  return candidate;
}

export function registerKnowledgeAsset(input: {
  projectId?: unknown;
  name?: unknown;
  mime?: unknown;
  mode?: unknown;
  sourcePath?: unknown;
  contentBase64?: unknown;
  annotations?: unknown;
}, root = knowledgeVaultPath()) {
  const safeRoot = ensureKnowledgeVault(root);
  const projectId = String(input.projectId || 'Shared').replace(/[^a-zA-Z0-9 _-]/g, '-').trim() || 'Shared';
  const mode = input.mode === 'link' ? 'link' : 'copy';
  const now = new Date().toISOString();
  const name = cleanAssetName(input.name || input.sourcePath);
  let storedPath = '';
  let sourcePath = '';
  let absolute = '';
  if (mode === 'link') {
    sourcePath = path.resolve(expandHome(String(input.sourcePath || '')));
    if (!path.isAbsolute(sourcePath) || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      throw new Error('Linked assets require an existing absolute file path.');
    }
    absolute = sourcePath;
  } else {
    const buffer = Buffer.from(String(input.contentBase64 || ''), 'base64');
    if (!buffer.length) throw new Error('Copied assets require file content.');
    if (buffer.length > 250 * 1024 * 1024) throw new Error('Assets are limited to 250 MB.');
    storedPath = uniqueAssetPath(`Projects/${projectId}/Assets/${name}`, safeRoot);
    absolute = vaultAbsolute(storedPath, safeRoot);
    atomicWrite(absolute, buffer);
  }
  const stat = fs.statSync(absolute);
  const asset: KnowledgeAsset = {
    id: randomUUID(),
    projectId,
    name,
    mode,
    path: storedPath,
    sourcePath,
    mime: String(input.mime || 'application/octet-stream').slice(0, 160),
    size: stat.size,
    contentHash: hashFile(absolute),
    available: true,
    annotations: String(input.annotations || '').slice(0, 20_000),
    createdAt: now,
    updatedAt: now
  };
  const store = readAssetStore(safeRoot);
  store.assets.push(asset);
  writeAssetStore(store, safeRoot);
  return asset;
}

export function listKnowledgeAssets(root = knowledgeVaultPath()) {
  const safeRoot = ensureKnowledgeVault(root);
  const store = readAssetStore(safeRoot);
  let changed = false;
  store.assets = store.assets.map((asset) => {
    const absolute = asset.mode === 'copy' ? vaultAbsolute(asset.path, safeRoot) : asset.sourcePath;
    const available = Boolean(absolute && fs.existsSync(absolute) && fs.statSync(absolute).isFile());
    if (available !== asset.available) changed = true;
    if (!available) return { ...asset, available };
    const stat = fs.statSync(absolute);
    if (stat.size !== asset.size) {
      changed = true;
      return { ...asset, available, size: stat.size, contentHash: hashFile(absolute), updatedAt: stat.mtime.toISOString() };
    }
    return { ...asset, available };
  });
  if (changed) writeAssetStore(store, safeRoot);
  return store.assets;
}

export function readKnowledgeAsset(id: string, root = knowledgeVaultPath()) {
  const asset = listKnowledgeAssets(root).find((candidate) => candidate.id === id);
  if (!asset) return null;
  const absolute = asset.mode === 'copy' ? vaultAbsolute(asset.path, root) : asset.sourcePath;
  if (!asset.available || !fs.existsSync(absolute)) return { asset, content: null };
  return { asset, content: fs.readFileSync(absolute) };
}

export function startVaultWatcher(root = knowledgeVaultPath()) {
  const safeRoot = validateRoot(root);
  if (watchers.has(safeRoot) || !fs.existsSync(safeRoot)) return;
  try {
    const watcher = fs.watch(safeRoot, { recursive: true, persistent: false }, () => {
      revisions.set(safeRoot, (revisions.get(safeRoot) || 0) + 1);
    });
    watchers.set(safeRoot, watcher);
  } catch {
    // Scan-on-read remains the compatibility fallback on filesystems without recursive watch.
  }
}

export function vaultRevision(root = knowledgeVaultPath()) {
  return revisions.get(validateRoot(root)) || 0;
}

export function resetKnowledgeVaultForTests() {
  for (const watcher of watchers.values()) watcher.close();
  watchers.clear();
  revisions.clear();
}
