import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

type ReleaseManifest = {
  filename?: string;
  contentType?: string;
  sha256?: string;
};

type DownloadObject = {
  body: ReadableStream;
  size: number;
  httpEtag: string;
  json<T>(): Promise<T>;
};

type DownloadBucket = {
  get(key: string): Promise<DownloadObject | null>;
};

export const GET: RequestHandler = async ({ params, platform }) => {
  const target = params.platform === 'windows' ? 'windows' : params.platform === 'macos' ? 'macos' : null;
  if (!target) error(404, 'Release not found.');

  const bucket = (platform as unknown as { env?: { DOWNLOADS?: DownloadBucket } } | undefined)?.env?.DOWNLOADS;
  if (!bucket) error(503, 'Desktop downloads are not configured on this environment.');

  const manifestObject = await bucket.get(`releases/latest-${target}.json`);
  if (!manifestObject) error(404, `${target === 'windows' ? 'Windows' : 'macOS'} download is not available yet.`);
  const manifest = await manifestObject.json<ReleaseManifest>();
  const filename = String(manifest.filename || '').replace(/[^a-zA-Z0-9._-]/g, '');
  if (!filename) error(500, 'Release metadata is incomplete.');

  const artifact = await bucket.get(`releases/${filename}`);
  if (!artifact) error(404, 'Release artifact is not available yet.');
  return new Response(artifact.body, {
    headers: {
      'content-type': manifest.contentType || 'application/octet-stream',
      'content-length': String(artifact.size),
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'public, max-age=300',
      etag: artifact.httpEtag,
      ...(manifest.sha256 ? { 'x-hii-sha256': manifest.sha256 } : {})
    }
  });
};
