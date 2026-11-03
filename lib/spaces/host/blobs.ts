import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { readSpace, validateSpaceId } from '../../server/space-store.ts';
import { evaluateSpacePolicy, type SpacePolicyActor } from '../policy.ts';
import type { SpaceAudience } from '../types.ts';
import { withFileLock } from '../../server/atomic-write.ts';
import { runtimeRoot } from '../../server/runtime-root.ts';
import {
  inspectAndSanitizeSpaceImage,
  safeSpaceAssetName,
  SPACE_UPLOAD_LIMITS,
  SpaceUploadError
} from '../upload-policy.ts';

const BLOB_ID = /^blob_[a-f0-9]{32}$/;
const SUPPORTED_EXTENSIONS = new Set(['jpg', 'png', 'webp']);

export type SpaceBlob = {
  name: string;
  mime: string;
  size: number;
  path: string;
  url: string;
  sha256: string;
  width: number;
  height: number;
};

export type RetrievedSpaceBlob = {
  bytes: Buffer;
  mime: string;
  filename: string;
};

function runtimeDir() {
  return runtimeRoot();
}

export function spaceAssetsDirectory(spaceId: string) {
  return path.join(runtimeDir(), 'workspace', 'assets', validateSpaceId(spaceId));
}

function validateBlobId(blobId: string) {
  if (!BLOB_ID.test(blobId)) throw new TypeError('invalid Space blob id');
  return blobId;
}

async function secureSpaceDirectory(spaceId: string) {
  const workspace = path.join(runtimeDir(), 'workspace');
  await mkdir(workspace, { recursive: true });
  const workspaceInfo = await lstat(workspace);
  if (workspaceInfo.isSymbolicLink() || !workspaceInfo.isDirectory()) {
    throw new SpaceUploadError('UNSAFE_STORAGE', 'Space blob storage is unavailable.', 503);
  }
  const root = path.join(workspace, 'assets');
  await mkdir(root, { recursive: true });
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new SpaceUploadError('UNSAFE_STORAGE', 'Space blob storage is unavailable.', 503);
  }
  const directory = spaceAssetsDirectory(spaceId);
  await mkdir(directory, { recursive: true });
  const directoryInfo = await lstat(directory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new SpaceUploadError('UNSAFE_STORAGE', 'Space blob storage is unavailable.', 503);
  }
  const resolvedRoot = await realpath(root);
  const resolvedDirectory = await realpath(directory);
  if (path.dirname(resolvedDirectory) !== resolvedRoot) {
    throw new SpaceUploadError('UNSAFE_STORAGE', 'Space blob storage is unavailable.', 503);
  }
  return directory;
}

async function usedBytes(directory: string) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const info = await lstat(path.join(directory, entry.name));
    if (!info.isSymbolicLink()) total += info.size;
  }
  return total;
}

export async function storeSpaceBlob(input: {
  spaceId: string;
  originalName: string;
  declaredMime?: string;
  bytes: Buffer;
  audience?: SpaceAudience;
  actor?: SpacePolicyActor;
}): Promise<SpaceBlob> {
  const space = await readSpace(input.spaceId);
  const directory = await secureSpaceDirectory(space.id);
  return withFileLock(path.join(directory, '.blobs'), async () => {
    const currentSpace = await readSpace(space.id);
    const preliminary = evaluateSpacePolicy(currentSpace.policy, {
      audience: input.audience ?? 'local',
      actor: input.actor ?? 'host',
      operation: 'upload',
      uploadBytes: 0,
      storageUsedBytes: 0
    });
    if (!preliminary.allowed && preliminary.reason === 'POLICY_UPLOADS_DISABLED') {
      throw new SpaceUploadError('UPLOADS_DISABLED', 'Uploads are disabled for this Space.', 403);
    }
    if (!preliminary.allowed && preliminary.reason === 'POLICY_WRITES_FROZEN') {
      throw new SpaceUploadError('SPACE_FROZEN', 'This Space is frozen.', 423);
    }
    const image = inspectAndSanitizeSpaceImage(input.bytes, currentSpace.policy.maxUploadBytes);
    const storageUsedBytes = await usedBytes(directory);
    const decision = evaluateSpacePolicy(currentSpace.policy, {
      audience: input.audience ?? 'local',
      actor: input.actor ?? 'host',
      operation: 'upload',
      uploadBytes: image.bytes.length,
      storageUsedBytes
    });
    if (!decision.allowed) {
      const mapped: [string, string, number] = decision.reason === 'POLICY_UPLOADS_DISABLED'
        ? ['UPLOADS_DISABLED', 'Uploads are disabled for this Space.', 403]
        : decision.reason === 'POLICY_WRITES_FROZEN'
          ? ['SPACE_FROZEN', 'This Space is frozen.', 423]
          : decision.reason === 'POLICY_UPLOAD_TOO_LARGE'
            ? ['UPLOAD_TOO_LARGE', 'The image exceeds this Space upload limit.', 413]
            : decision.reason === 'POLICY_STORAGE_QUOTA_EXCEEDED'
              ? ['SPACE_QUOTA_EXCEEDED', 'This Space has reached its storage quota.', 413]
              : ['UPLOAD_NOT_ALLOWED', 'This Space policy does not allow the upload.', 403];
      throw new SpaceUploadError(...mapped);
    }
    const blobId = `blob_${randomBytes(16).toString('hex')}`;
    const filename = `${blobId}.${image.extension}`;
    const file = path.join(directory, filename);
    const handle = await open(
      file,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    );
    try {
      await handle.writeFile(image.bytes);
    } catch (error) {
      await rm(file, { force: true }).catch(() => {});
      throw error;
    } finally {
      await handle.close().catch(() => {});
    }
    const name = safeSpaceAssetName(input.originalName);
    return {
      name,
      mime: image.mime,
      size: image.bytes.length,
      path: `space://${space.id}/${blobId}`,
      url: `/api/spaces/${space.id}/blobs/${blobId}`,
      sha256: createHash('sha256').update(image.bytes).digest('hex'),
      width: image.width,
      height: image.height
    };
  });
}

async function blobFilename(spaceId: string, blobId: string) {
  const directory = await secureSpaceDirectory(spaceId);
  const matches = (await readdir(directory)).filter((name) => {
    const [id, extension, extra] = name.split('.');
    return id === blobId && !extra && SUPPORTED_EXTENSIONS.has(extension);
  });
  if (matches.length !== 1) return null;
  return { directory, filename: matches[0] };
}

export async function readSpaceBlob(spaceId: string, rawBlobId: string): Promise<RetrievedSpaceBlob | null> {
  const space = await readSpace(spaceId);
  const blobId = validateBlobId(rawBlobId);
  const found = await blobFilename(space.id, blobId);
  if (!found) return null;
  const file = path.join(found.directory, found.filename);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) return null;
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const extension = path.extname(found.filename).slice(1);
    return {
      bytes: await handle.readFile(),
      mime: extension === 'jpg' ? 'image/jpeg' : `image/${extension}`,
      filename: found.filename
    };
  } finally {
    await handle.close();
  }
}

export async function deleteSpaceBlob(spaceId: string, rawBlobId: string): Promise<boolean> {
  await readSpace(spaceId);
  const blobId = validateBlobId(rawBlobId);
  const found = await blobFilename(spaceId, blobId);
  if (!found) return false;
  const file = path.join(found.directory, found.filename);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) return false;
  await rm(file);
  return true;
}

function multipartBoundary(contentType: string | undefined) {
  const match = /^multipart\/form-data\s*;\s*boundary=(?:"([A-Za-z0-9'()+_,.\/:=?-]{1,70})"|([A-Za-z0-9'()+_,.\/:=?-]{1,70}))$/i.exec(contentType ?? '');
  if (!match) throw new SpaceUploadError('INVALID_MULTIPART', 'Expected one multipart file field.', 400);
  return match[1] ?? match[2];
}

export async function readMultipartSpaceUpload(request: IncomingMessage, policyMaxBytes: number) {
  const boundary = multipartBoundary(request.headers['content-type']);
  const maxFileBytes = Math.min(SPACE_UPLOAD_LIMITS.hardMaxBytes, Math.max(0, policyMaxBytes));
  const maxBodyBytes = maxFileBytes + SPACE_UPLOAD_LIMITS.multipartOverheadBytes;
  const declaredLength = request.headers['content-length'];
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBodyBytes)) {
    throw new SpaceUploadError('UPLOAD_TOO_LARGE', 'The image exceeds this Space upload limit.', 413);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBodyBytes) {
      throw new SpaceUploadError('UPLOAD_TOO_LARGE', 'The image exceeds this Space upload limit.', 413);
    }
    chunks.push(bytes);
  }
  const body = Buffer.concat(chunks);
  const delimiter = Buffer.from(`--${boundary}`);
  if (!body.subarray(0, delimiter.length).equals(delimiter)) {
    throw new SpaceUploadError('INVALID_MULTIPART', 'The multipart body is invalid.', 400);
  }
  let cursor = delimiter.length;
  if (body.toString('ascii', cursor, cursor + 2) !== '\r\n') {
    throw new SpaceUploadError('INVALID_MULTIPART', 'The multipart body is invalid.', 400);
  }
  cursor += 2;
  const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), cursor);
  if (headerEnd < 0 || headerEnd - cursor > SPACE_UPLOAD_LIMITS.multipartHeaderBytes) {
    throw new SpaceUploadError('INVALID_MULTIPART', 'The multipart headers are invalid.', 400);
  }
  const headers = body.toString('latin1', cursor, headerEnd);
  if (/\r\n[ \t]/.test(headers) || !/^content-disposition:/im.test(headers)) {
    throw new SpaceUploadError('INVALID_MULTIPART', 'The multipart headers are invalid.', 400);
  }
  const disposition = /^content-disposition:\s*form-data;\s*name="file";\s*filename="([^"\r\n]*)"\s*$/im.exec(headers);
  if (!disposition) throw new SpaceUploadError('INVALID_MULTIPART', 'Expected multipart field "file".', 400);
  const type = /^content-type:\s*([^\r\n]+)$/im.exec(headers)?.[1].trim();
  const contentStart = headerEnd + 4;
  const nextBoundary = body.indexOf(Buffer.from(`\r\n--${boundary}`), contentStart);
  if (nextBoundary < 0) throw new SpaceUploadError('INVALID_MULTIPART', 'The multipart body is incomplete.', 400);
  const afterBoundary = nextBoundary + 2 + delimiter.length;
  if (body.toString('ascii', afterBoundary, afterBoundary + 2) !== '--' || !/^\r?\n?$/.test(body.toString('ascii', afterBoundary + 2))) {
    throw new SpaceUploadError('INVALID_MULTIPART', 'Only one file may be uploaded at a time.', 400);
  }
  const bytes = body.subarray(contentStart, nextBoundary);
  if (bytes.length > maxFileBytes) {
    throw new SpaceUploadError('UPLOAD_TOO_LARGE', 'The image exceeds this Space upload limit.', 413);
  }
  return { originalName: disposition[1], declaredMime: type, bytes };
}
