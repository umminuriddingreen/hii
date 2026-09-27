import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sensitiveWorkspaceContextSource } from '../workspace/run-boundary.ts';
import {
  normalizeWorkspaceContextAnchor,
  workspaceContextAnchorInstruction,
  type WorkspaceContextAnchor
} from '../workspace/context-anchor.ts';

export type WorkspaceRunContextItem = {
  id: string;
  title: string;
  type: string;
  source?: string;
  expectedSha256?: string;
  anchor?: WorkspaceContextAnchor;
  excerpt?: string;
  objectKind?: string;
  owner?: string;
  authority?: string;
  proofRefs?: string[];
};

export type WorkspaceRunContextPreviewItem = WorkspaceRunContextItem & {
  access:
    | 'workspace-file'
    | 'workspace-directory'
    | 'staged-local-asset'
    | 'inline-snapshot'
    | 'remote-reference'
    | 'opaque-reference'
    | 'label-only'
    | 'blocked';
  provenance: string;
  network: 'none' | 'read-only-web';
  relativePath?: string;
  stagedRelativePath?: string;
  sha256?: string;
  byteSize?: number;
  modifiedAt?: string;
  notice?: string;
  warning?: string;
  blockedReason?: string;
};

export type WorkspaceRunContextPreview = {
  generatedAt: string;
  runId: string;
  workspaceRoot: string;
  fingerprint: string;
  blocked: boolean;
  blockers: string[];
  warnings: string[];
  items: WorkspaceRunContextPreviewItem[];
  summary: {
    selected: number;
    executable: number;
    workspaceFiles: number;
    stagedLocalAssets: number;
    inlineSnapshots: number;
    remoteReferences: number;
    labelOnly: number;
  };
  network: {
    required: boolean;
    scope: string;
  };
};

function clean(value: unknown, max: number) {
  return String(value ?? '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanId(value: unknown) {
  return clean(value, 120).replace(/[^a-zA-Z0-9_-]/g, '');
}

function cleanSha256(value: unknown) {
  const sha256 = clean(value, 64).toLowerCase();
  return /^[a-f0-9]{64}$/.test(sha256) ? sha256 : '';
}

function cleanList(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => clean(item, maxLength)).filter(Boolean).slice(0, maxItems);
}

export function normalizeWorkspaceRunContext(value: unknown): WorkspaceRunContextItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const item = entry as Record<string, unknown>;
      const id = cleanId(item.id);
      const title = clean(item.title, 240);
      const type = clean(item.type, 80);
      if (!id || !title || !type) return null;
      const source = clean(item.source, 1000);
      const expectedSha256 = cleanSha256(item.expectedSha256);
      const anchor = normalizeWorkspaceContextAnchor(item.anchor);
      const excerpt = clean(item.excerpt, 2400);
      const objectKind = clean(item.objectKind, 80);
      const owner = clean(item.owner, 80);
      const authority = clean(item.authority, 80);
      const proofRefs = cleanList(item.proofRefs, 12, 240);
      return {
        id,
        title,
        type,
        ...(source ? { source } : {}),
        ...(expectedSha256 ? { expectedSha256 } : {}),
        ...(anchor ? { anchor } : {}),
        ...(excerpt ? { excerpt } : {}),
        ...(objectKind ? { objectKind } : {}),
        ...(owner ? { owner } : {}),
        ...(authority ? { authority } : {}),
        ...(proofRefs.length ? { proofRefs } : {})
      };
    })
    .filter((entry): entry is WorkspaceRunContextItem => Boolean(entry))
    .slice(0, 24);
}

export async function resolveWorkspaceRunRoot(value: unknown) {
  const requested = clean(value, 1000);
  const resolved = requested ? await realpath(requested).catch(() => '') : '';
  if (!resolved) throw new Error('The selected workspace root does not exist.');
  if ([path.parse(resolved).root, os.homedir()].includes(resolved)) {
    throw new Error('Choose a specific project folder, not a filesystem or home-directory root.');
  }
  return resolved;
}

function insideRoot(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function managedAssetRoot() {
  const runtimeRoot = process.env.HII_RUNTIME_DIR || path.join(os.homedir(), '.hii');
  return realpath(path.join(runtimeRoot, 'workspace', 'assets')).catch(() => '');
}

function stagedAssetRelativePath(runId: string, sha256: string, source: string) {
  const extension = path.extname(source).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 16);
  return path.join('.hii-run-context', runId, `${sha256}${extension}`);
}

function localSourcePath(source: string, root: string) {
  if (!source) return '';
  if (source.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(source).pathname);
    } catch {
      return '';
    }
  }
  if (path.isAbsolute(source)) return source;
  if (source.startsWith('./') || source.startsWith('../')) return path.resolve(root, source);
  if (!/\s/.test(source) && !/^[a-z][a-z0-9+.-]*:/i.test(source)) {
    return path.resolve(root, source);
  }
  return '';
}

async function fileSha256(file: string) {
  return new Promise<string>((resolve, reject) => {
    const digest = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(digest.digest('hex')));
  });
}

function stablePreviewShape(
  runId: string,
  workspaceRoot: string,
  items: WorkspaceRunContextPreviewItem[]
) {
  return {
    runId,
    workspaceRoot,
    items: items.map((item) => ({
      id: item.id,
      title: item.title,
      type: item.type,
      source: item.source || '',
      expectedSha256: item.expectedSha256 || '',
      anchor: item.anchor || null,
      excerpt: item.excerpt || '',
      objectKind: item.objectKind || '',
      owner: item.owner || '',
      authority: item.authority || '',
      proofRefs: item.proofRefs || [],
      access: item.access,
      provenance: item.provenance,
      network: item.network,
      relativePath: item.relativePath || '',
      stagedRelativePath: item.stagedRelativePath || '',
      sha256: item.sha256 || '',
      byteSize: item.byteSize ?? null,
      modifiedAt: item.modifiedAt || '',
      notice: item.notice || '',
      warning: item.warning || '',
      blockedReason: item.blockedReason || ''
    }))
  };
}

export async function previewWorkspaceRunContext(input: {
  runId?: unknown;
  workspaceRoot?: unknown;
  context?: unknown;
}): Promise<WorkspaceRunContextPreview> {
  const runId = cleanId(input.runId) || 'context-preview';
  const workspaceRoot = await resolveWorkspaceRunRoot(input.workspaceRoot);
  const assetRoot = await managedAssetRoot();
  const context = normalizeWorkspaceRunContext(input.context);
  const items: WorkspaceRunContextPreviewItem[] = [];

  for (const item of context) {
    const source = item.source || '';
    if (sensitiveWorkspaceContextSource(source)) {
      items.push({
        ...item,
        access: 'blocked',
        provenance: 'secret-like source rejected',
        network: 'none',
        blockedReason: 'Secret-like files and credential-bearing URLs cannot be attached.'
      });
      continue;
    }

    if (/^https?:\/\//i.test(source)) {
      items.push({
        ...item,
        access: 'remote-reference',
        provenance: 'selected remote source reference',
        network: 'read-only-web',
        warning: 'The reference is not cached in this context pack. HII may need a governed outbound read to retrieve it.'
      });
      continue;
    }

    const candidate = localSourcePath(source, workspaceRoot);
    if (candidate) {
      const resolved = await realpath(candidate).catch(() => '');
      if (!resolved) {
        items.push({
          ...item,
          access: 'blocked',
          provenance: 'unresolved local source',
          network: 'none',
          blockedReason: 'The selected local source no longer exists.'
        });
        continue;
      }
      if (assetRoot && insideRoot(assetRoot, resolved)) {
        const details = await stat(resolved);
        if (!details.isFile()) {
          items.push({
            ...item,
            access: 'blocked',
            provenance: 'unsupported HII-managed source',
            network: 'none',
            blockedReason: 'The selected HII-managed source is not a regular file.'
          });
          continue;
        }
        if (details.size > 250 * 1024 * 1024) {
          items.push({
            ...item,
            access: 'blocked',
            provenance: 'oversized HII-managed source',
            network: 'none',
            blockedReason: 'The selected local asset exceeds the 250 MB governed staging limit.'
          });
          continue;
        }
        const sha256 = await fileSha256(resolved);
        if (item.expectedSha256 && item.expectedSha256 !== sha256) {
          items.push({
            ...item,
            access: 'blocked',
            provenance: 'HII-managed source integrity mismatch',
            network: 'none',
            sha256,
            blockedReason: 'The selected local asset no longer matches the integrity proof recorded on its canvas object.'
          });
          continue;
        }
        items.push({
          ...item,
          access: 'staged-local-asset',
          provenance: 'content-addressed HII asset selected for a read-only per-run copy',
          network: 'none',
          sha256,
          byteSize: details.size,
          modifiedAt: details.mtime.toISOString(),
          stagedRelativePath: stagedAssetRelativePath(runId, sha256, resolved),
          notice: 'HII will reverify this asset, copy it inside the approved workspace only for this run, and remove that disposable copy after the run reaches a terminal state.'
        });
        continue;
      }
      if (!insideRoot(workspaceRoot, resolved)) {
        items.push({
          ...item,
          access: 'blocked',
          provenance: 'outside approved workspace root',
          network: 'none',
          blockedReason: 'The bounded runner cannot read this local source because it is outside the approved workspace root.'
        });
        continue;
      }
      const details = await stat(resolved);
      const relativePath = path.relative(workspaceRoot, resolved) || '.';
      if (details.isDirectory()) {
        items.push({
          ...item,
          access: 'workspace-directory',
          provenance: 'approved workspace directory',
          network: 'none',
          relativePath,
          modifiedAt: details.mtime.toISOString()
        });
        continue;
      }
      if (!details.isFile()) {
        items.push({
          ...item,
          access: 'blocked',
          provenance: 'unsupported local source',
          network: 'none',
          blockedReason: 'The selected local source is not a regular file or directory.'
        });
        continue;
      }
      items.push({
        ...item,
        access: 'workspace-file',
        provenance: 'content-hashed file inside approved workspace root',
        network: 'none',
        relativePath,
        sha256: await fileSha256(resolved),
        byteSize: details.size,
        modifiedAt: details.mtime.toISOString()
      });
      continue;
    }

    if (item.excerpt) {
      items.push({
        ...item,
        access: 'inline-snapshot',
        provenance: item.authority
          ? `selected ${item.authority} object snapshot`
          : 'selected canvas object snapshot',
        network: 'none'
      });
      continue;
    }

    if (source) {
      items.push({
        ...item,
        access: 'opaque-reference',
        provenance: 'named provenance reference',
        network: 'none',
        warning: 'This source is a provenance label, not a readable file or URL. Only its title and metadata enter the run.'
      });
      continue;
    }

    items.push({
      ...item,
      access: 'label-only',
      provenance: 'canvas label without source or content snapshot',
      network: 'none',
      warning: 'Only this object title and type enter the run.'
    });
  }

  const blockers = items
    .filter((item) => item.access === 'blocked')
    .map((item) => `${item.title}: ${item.blockedReason}`);
  const warnings = items
    .map((item) => item.warning)
    .filter((warning): warning is string => Boolean(warning));
  const remoteReferences = items.filter((item) => item.network === 'read-only-web').length;
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(stablePreviewShape(runId, workspaceRoot, items)))
    .digest('hex');

  return {
    generatedAt: new Date().toISOString(),
    runId,
    workspaceRoot,
    fingerprint,
    blocked: blockers.length > 0,
    blockers,
    warnings,
    items,
    summary: {
      selected: items.length,
      executable: items.filter((item) => item.access !== 'blocked').length,
      workspaceFiles: items.filter((item) =>
        item.access === 'workspace-file' || item.access === 'workspace-directory'
      ).length,
      stagedLocalAssets: items.filter((item) => item.access === 'staged-local-asset').length,
      inlineSnapshots: items.filter((item) => item.access === 'inline-snapshot').length,
      remoteReferences,
      labelOnly: items.filter((item) =>
        item.access === 'label-only' || item.access === 'opaque-reference'
      ).length
    },
    network: {
      required: remoteReferences > 0,
      scope: remoteReferences
        ? `${remoteReferences} selected remote reference${remoteReferences === 1 ? '' : 's'} may require governed outbound read-only web retrieval. Publishing, upload, messaging, spending, and secret export remain blocked.`
        : 'No selected context requires network retrieval. Publishing, upload, messaging, spending, and secret export remain blocked.'
    }
  };
}

export function workspaceRunExecutionGoal(
  goal: string,
  preview: WorkspaceRunContextPreview
) {
  if (!preview.items.length) return goal;
  const lines = preview.items.flatMap((item) => {
    const identity = `- ${item.title} (${item.type}; ${item.access})`;
    const details = [
      item.relativePath ? `  Workspace source: ${item.relativePath}` : '',
      item.stagedRelativePath ? `  Read-only staged source: ${item.stagedRelativePath}` : '',
      item.sha256 ? `  SHA-256: ${item.sha256}` : '',
      item.anchor ? `  Context anchor: ${workspaceContextAnchorInstruction(item.anchor)}` : '',
      item.source && item.access === 'remote-reference' ? `  Remote source: ${item.source}` : '',
      item.excerpt ? `  Approved snapshot: ${item.excerpt}` : '',
      item.proofRefs?.length ? `  Proof references: ${item.proofRefs.join(', ')}` : ''
    ].filter(Boolean);
    return [identity, ...details];
  });
  return [
    goal,
    '',
    `Approved HII execution context manifest ${preview.fingerprint}:`,
    ...lines,
    '',
    preview.network.scope,
    'Use only this approved context manifest and the approved workspace root. Do not silently expand the context boundary.'
  ].join('\n');
}
