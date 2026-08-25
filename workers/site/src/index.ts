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
  WAITLIST?: D1Database;
}

/** Surfaces someone can wait on. Anything else is not a real signup. */
const SURFACES = new Set(['hii', 'memory-dock', 'interform', 'concierge']);

const MAX_EMAIL = 254;
const MAX_NOTE = 500;

const PLATFORMS: Record<string, string> = {
  windows: 'Windows',
  macos: 'macOS'
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

/**
 * Deliberately narrow. This is not RFC 5322 — it is the shape a person types,
 * with the length bound that keeps a header-sized string out of the database.
 */
function usableEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_EMAIL && /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(value);
}

async function joinWaitlist(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'Use POST to join the waitlist.' });

  // The form is served from this origin. Rejecting everything else keeps the
  // endpoint from being a convenient open write for someone else's page.
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json(403, { error: 'Cross-origin signups are not accepted.' });

  if (!env.WAITLIST) return json(503, { error: 'The waitlist is not configured on this environment.' });

  let payload: { email?: unknown; surface?: unknown; note?: unknown };
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: 'Send a JSON body.' });
  }

  const email = usableEmail(payload.email) ? payload.email.trim().toLowerCase() : null;
  if (!email) return json(400, { error: 'That does not look like an email address.' });

  const surface = typeof payload.surface === 'string' && SURFACES.has(payload.surface) ? payload.surface : 'hii';
  const note = typeof payload.note === 'string' && payload.note.trim() ? payload.note.trim().slice(0, MAX_NOTE) : null;

  try {
    // Signing up twice is the same as signing up once. The response does not
    // distinguish the two, so the endpoint cannot be used to test whether a
    // given address is already on the list.
    await env.WAITLIST.prepare(
      'INSERT INTO waitlist (email, surface, note) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING'
    )
      .bind(email, surface, note)
      .run();
  } catch {
    return json(500, { error: 'The waitlist could not record that. Try again shortly.' });
  }

  return json(200, { ok: true });
}

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

    // `/` is the desktop app's entry point: the Tauri window loads index.html
    // straight off disk, so that route is the workspace shell and it expects a
    // local HII runtime that a visitor's browser does not have. The web is
    // served the landing page instead. Rewriting here rather than moving the
    // route keeps the shipped desktop app's entry point untouched.
    if (url.pathname === '/') {
      const landing = new URL('/home', url);
      return env.ASSETS.fetch(new Request(landing, request));
    }

    if (url.pathname === '/api/waitlist') return joinWaitlist(request, env, url);

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
