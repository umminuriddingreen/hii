/**
 * The public HII site worker.
 *
 * The site itself is a static Next export served from the ASSETS binding. The
 * one thing that cannot be static is the desktop download: the installer lives
 * in R2 and is published independently of the site build, so `/download/<platform>`
 * resolves the current release through a manifest at request time rather than
 * baking a filename into the page.
 *
 * Ported from the SvelteKit route this replaces, so the response contract that
 * existing download links depend on is unchanged.
 */

type ReleaseManifest = {
  filename?: string;
  contentType?: string;
  sha256?: string;
};

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DOWNLOADS?: R2Bucket;
}

const PLATFORMS: Record<string, string> = {
  windows: 'Windows',
  macos: 'macOS'
};

function fail(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

async function serveRelease(platform: string, env: Env): Promise<Response> {
  const label = PLATFORMS[platform];
  if (!label) return fail(404, 'Release not found.');
  if (!env.DOWNLOADS) return fail(503, 'Desktop downloads are not configured on this environment.');

  const manifestObject = await env.DOWNLOADS.get(`releases/latest-${platform}.json`);
  if (!manifestObject) return fail(404, `${label} download is not available yet.`);
  const manifest = await manifestObject.json<ReleaseManifest>();

  // The filename comes from R2 metadata and ends up in a header, so it is
  // constrained here rather than trusted.
  const filename = String(manifest.filename || '').replace(/[^a-zA-Z0-9._-]/g, '');
  if (!filename) return fail(500, 'Release metadata is incomplete.');

  const artifact = await env.DOWNLOADS.get(`releases/${filename}`);
  if (!artifact) return fail(404, 'Release artifact is not available yet.');

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
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const release = /^\/download\/([a-z]+)\/?$/.exec(url.pathname);
    if (release) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return fail(405, 'Method not allowed.');
      }
      return serveRelease(release[1], env);
    }
    return env.ASSETS.fetch(request);
  }
};
