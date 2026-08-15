import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const releaseAssets = new Set([
  'hii-aarch64-apple-darwin.tar.gz',
  'hii-aarch64-unknown-linux-gnu.tar.gz',
  'hii-x86_64-apple-darwin.tar.gz',
  'hii-x86_64-unknown-linux-gnu.tar.gz',
  'SHA256SUMS'
]);

type ReleaseObject = {
  body: ReadableStream;
  size: number;
  httpEtag: string;
  json<T>(): Promise<T>;
};

type ReleaseBucket = {
  get(key: string): Promise<ReleaseObject | null>;
};

export const GET: RequestHandler = async ({ params, platform }) => {
  const asset = params.asset;
  if (!releaseAssets.has(asset)) error(404, 'CLI release asset not found.');

  const bucket = (platform as unknown as { env?: { DOWNLOADS?: ReleaseBucket } } | undefined)?.env
    ?.DOWNLOADS;
  if (!bucket) error(503, 'CLI downloads are not configured on this environment.');

  const latest = await bucket.get('cli/releases/latest.json');
  if (!latest) error(404, 'No CLI release is published.');
  const { tag } = await latest.json<{ tag?: string }>();
  if (!tag || !/^cli-v\d+\.\d+\.\d+$/.test(tag)) error(500, 'CLI release metadata is invalid.');

  const object = await bucket.get(`cli/releases/${tag}/${asset}`);
  if (!object) error(404, 'CLI release asset is unavailable.');

  return new Response(object.body, {
    headers: {
      'content-type': asset === 'SHA256SUMS' ? 'text/plain; charset=utf-8' : 'application/gzip',
      'content-length': String(object.size),
      'content-disposition': `attachment; filename="${asset}"`,
      'cache-control': 'public, max-age=300',
      etag: object.httpEtag
    }
  });
};
