import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getWorkspaceRun } from './hii-workspace-runs.ts';

const maxEditableBytes = 2 * 1024 * 1024;
const editableExtensions = new Set([
  '', 'md', 'mdx', 'txt', 'json', 'jsonl', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'svelte',
  'css', 'scss', 'html', 'svg', 'xml', 'yaml', 'yml', 'toml', 'csv', 'py', 'rs', 'go', 'sh',
  'zsh', 'fish', 'sql', 'log'
]);
const imageTypes: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml'
};
const maxPreviewBytes = 25 * 1024 * 1024;

function runtimeRoot() {
  return process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii');
}

function clean(value: unknown, max: number) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanPath(value: unknown, max = 2000) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

function hash(body: Uint8Array | string) {
  return createHash('sha256').update(body).digest('hex');
}

function inside(root: string, target: string) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function listedArtifactPath(root: string, artifact: string) {
  return path.resolve(path.isAbsolute(artifact) ? artifact : path.join(root, artifact));
}

async function resolveArtifact(runIdValue: unknown, artifactValue: unknown) {
  const runId = clean(runIdValue, 120).replace(/[^a-zA-Z0-9_-]/g, '');
  const artifact = cleanPath(artifactValue);
  if (!runId || !artifact) throw new Error('A workspace run id and artifact path are required.');
  const run = await getWorkspaceRun(runId);
  if (!run || run.job.status !== 'completed' || !run.receipt) {
    throw new Error('Only artifacts from a completed workspace run can be opened here.');
  }
  const rootValue = cleanPath(run.job.metadata?.workspaceRoot);
  const root = await realpath(rootValue).catch(() => '');
  if (!root) throw new Error('The approved workspace root is no longer available.');
  const listed = Array.isArray(run.receipt.artifacts) ? run.receipt.artifacts.map((entry) => cleanPath(entry)) : [];
  const requestedPath = listedArtifactPath(root, artifact);
  const matched = listed.find((entry) => listedArtifactPath(root, entry) === requestedPath);
  if (!matched) throw new Error('The file is not named in this run receipt.');
  const target = await realpath(requestedPath).catch(() => '');
  if (!target || !inside(root, target)) throw new Error('The artifact is outside the approved workspace boundary.');
  return { runId, artifact: matched, root, target, run };
}

export async function readWorkspaceRunArtifact(input: { runId?: unknown; artifact?: unknown }) {
  const resolved = await resolveArtifact(input.runId, input.artifact);
  const info = await stat(resolved.target);
  if (!info.isFile()) throw new Error('The receipt artifact is not a regular file.');
  const extension = path.extname(resolved.target).slice(1).toLowerCase();
  const editable = editableExtensions.has(extension) && info.size <= maxEditableBytes;
  let content: string | null = null;
  let revision = '';
  if (editable) {
    const body = await readFile(resolved.target);
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      throw new Error('The receipt artifact is not valid UTF-8 text.');
    }
    revision = hash(body);
  }
  return {
    runId: resolved.runId,
    artifact: resolved.artifact,
    path: resolved.target,
    name: path.basename(resolved.target),
    extension,
    mediaType: imageTypes[extension] || null,
    previewable: Boolean(imageTypes[extension]) && info.size <= maxPreviewBytes,
    size: info.size,
    editable,
    content,
    revision,
    sourceReceipt: resolved.run.path,
    workspaceRoot: resolved.root
  };
}

export async function readWorkspaceRunArtifactPreview(input: { runId?: unknown; artifact?: unknown }) {
  const resolved = await resolveArtifact(input.runId, input.artifact);
  const info = await stat(resolved.target);
  if (!info.isFile()) throw new Error('The receipt artifact is not a regular file.');
  const extension = path.extname(resolved.target).slice(1).toLowerCase();
  const mediaType = imageTypes[extension];
  if (!mediaType) throw new Error('Only supported receipt-linked images can be previewed.');
  if (info.size > maxPreviewBytes) throw new Error('Receipt image previews are limited to 25 MB.');
  const body = await readFile(resolved.target);
  return { body, mediaType, revision: hash(body) };
}

export async function saveWorkspaceRunArtifact(input: {
  runId?: unknown;
  artifact?: unknown;
  content?: unknown;
  ifMatch?: unknown;
}) {
  const current = await readWorkspaceRunArtifact(input);
  if (!current.editable || current.content === null) throw new Error('This receipt artifact is not editable in HII.');
  const expected = clean(input.ifMatch, 128);
  if (!expected || expected !== current.revision) {
    const error = new Error('The artifact changed since it was opened. Reload before saving.');
    Object.assign(error, { status: 409 });
    throw error;
  }
  const content = String(input.content ?? '');
  const body = Buffer.from(content, 'utf8');
  if (body.byteLength > maxEditableBytes) throw new Error('Editable HII artifacts are limited to 2 MB.');
  const info = await stat(current.path);
  const temporary = path.join(path.dirname(current.path), `.${path.basename(current.path)}.hii-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, body, { mode: info.mode });
    await chmod(temporary, info.mode);
    await rename(temporary, current.path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  const editedAt = new Date().toISOString();
  const edit = {
    id: randomUUID(),
    kind: 'workspace.artifact.edited',
    actor: 'human',
    runId: current.runId,
    artifact: current.artifact,
    path: current.path,
    previousRevision: current.revision,
    revision: hash(body),
    bytes: body.byteLength,
    editedAt,
    sourceReceipt: current.sourceReceipt
  };
  const log = path.join(runtimeRoot(), 'workspace', 'artifact-edits.jsonl');
  await mkdir(path.dirname(log), { recursive: true });
  await appendFile(log, `${JSON.stringify(edit)}\n`, 'utf8');
  return {
    ...current,
    size: body.byteLength,
    content,
    revision: edit.revision,
    edit
  };
}
