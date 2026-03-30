import http from 'node:http';
import { URL } from 'node:url';
import { loadConfig } from './config.js';
import { orchestrateIntent } from './orchestrator.js';
import { VectorStore } from './store/vectordb.js';
import { ingestPath } from './rag/ingest.js';
import fs from 'node:fs';
import path from 'node:path';
import { buildVaultGraph } from './graph.js';
import { execFile } from 'node:child_process';
import { runAgentBrowser } from './tools/browser.js';
import { focusSpaceWindow, getSpaceHealth, getSpaceSnapshot, switchSpaceWorkspace } from './tools/space.js';
import { buildRemoteUrl, getRemote, listRemotes } from './remote.js';

type ServeOpts = {
  port?: number;
  allowShell?: boolean;
  allowSearch?: boolean;
  webProvider?: 'serpapi' | 'duckduckgo';
  scholarly?: boolean;
  downloadPdfs?: boolean;
  memory?: boolean;
};

function send(res: http.ServerResponse, code: number, data: any) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(body);
}

const HOME_DIR = process.env.HOME || '/Users/ummi';

function latestMtimeMs(target: string): number {
  try {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return stat.mtimeMs;
    let newest = stat.mtimeMs;
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (entry.name.startsWith('.git')) continue;
      const full = path.join(target, entry.name);
      newest = Math.max(newest, latestMtimeMs(full));
    }
    return newest;
  } catch {
    return 0;
  }
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js' || ext === '.mjs') return 'application/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'text/plain; charset=utf-8';
}

function injectLiveReload(html: string, watchPath: string): string {
  const script = `
<script>
(() => {
  const watchPath = ${JSON.stringify(watchPath)};
  let lastSeen = 0;
  async function poll() {
    try {
      const res = await fetch('/__hii/watch?path=' + encodeURIComponent(watchPath), { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (!lastSeen) {
        lastSeen = data.mtimeMs || 0;
        return;
      }
      if ((data.mtimeMs || 0) > lastSeen) {
        window.location.reload();
      }
    } catch {}
  }
  setInterval(poll, 700);
})();
</script>`;
  if (html.includes('</body>')) return html.replace('</body>', `${script}\n</body>`);
  return html + script;
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export async function startServer(opts: ServeOpts = {}) {
  const cfg = loadConfig();
  const port = opts.port ?? 8787;
  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) return send(res, 400, { error: 'missing url' });
      const u = new URL(req.url, `http://localhost:${port}`);
      if (req.method === 'OPTIONS') return send(res, 204, {});

      if (u.pathname === '/healthz') {
        return send(res, 200, { ok: true });
      }

      if (u.pathname === '/live' && req.method === 'GET') {
        if (!cfg.obsidianVaultPath) return send(res, 200, { enabled: false, mtimeMs: 0 });
        return send(res, 200, {
          enabled: true,
          mtimeMs: latestMtimeMs(cfg.obsidianVaultPath)
        });
      }

      if (u.pathname === '/__hii/watch' && req.method === 'GET') {
        const raw = u.searchParams.get('path');
        if (!raw) return send(res, 400, { error: 'path required' });
        const abs = path.resolve(raw);
        if (!abs.startsWith(HOME_DIR)) return send(res, 400, { error: 'invalid path' });
        return send(res, 200, { path: abs, mtimeMs: latestMtimeMs(abs) });
      }

      if (u.pathname === '/chat' && req.method === 'POST') {
        const body = await readJson(req);
        const prompt: string = body?.prompt ?? '';
        if (!prompt) return send(res, 400, { error: 'prompt required' });
        const merged = { ...cfg, allowShell: !!(body?.allowShell ?? opts.allowShell ?? cfg.allowShell), allowSearch: !!(body?.allowSearch ?? opts.allowSearch ?? cfg.allowSearch) };
        const result = await orchestrateIntent(merged, prompt, {
          webProvider: body?.webProvider ?? opts.webProvider,
          scholarly: !!(body?.scholarly ?? opts.scholarly),
          downloadPdfs: !!(body?.downloadPdfs ?? opts.downloadPdfs),
          useMemory: body?.memory ?? (opts.memory ?? cfg.memoryEnabled)
        });
        return send(res, 200, {
          text: result.text,
          intent: result.intent,
          usedTools: result.usedTools,
          events: result.events,
        });
      }

      if (u.pathname === '/ingest' && req.method === 'POST') {
        const body = await readJson(req);
        const p: string = body?.path;
        if (!p) return send(res, 400, { error: 'path required' });
        const db = new VectorStore(cfg.dbPath);
        const count = await ingestPath(db, cfg.embedModel, p);
        return send(res, 200, { ok: true, chunks: count });
      }

      if (u.pathname === '/browser' && req.method === 'POST') {
        const body = await readJson(req);
        const args = Array.isArray(body?.args) ? body.args.map(String) : [];
        const result = await runAgentBrowser(args);
        return send(res, result.code === 0 ? 200 : 500, result);
      }

      if (u.pathname === '/space/healthz' && req.method === 'GET') {
        return send(res, 200, await getSpaceHealth());
      }

      if (u.pathname === '/space/snapshot' && req.method === 'GET') {
        try {
          return send(res, 200, await getSpaceSnapshot());
        } catch (e: any) {
          return send(res, 500, { error: e?.message || String(e) });
        }
      }

      if (u.pathname === '/space/action' && req.method === 'POST') {
        const body = await readJson(req);
        const action = String(body?.action || '');
        try {
          if (action === 'focus-window') {
            if (!body?.windowId) return send(res, 400, { error: 'windowId required' });
            return send(res, 200, await focusSpaceWindow(String(body.windowId)));
          }
          if (action === 'switch-workspace') {
            if (!body?.workspace) return send(res, 400, { error: 'workspace required' });
            return send(res, 200, await switchSpaceWorkspace(String(body.workspace)));
          }
          return send(res, 400, { error: 'unsupported action' });
        } catch (e: any) {
          return send(res, 500, { error: e?.message || String(e) });
        }
      }

      if (u.pathname === '/remotes' && req.method === 'GET') {
        const remotes = listRemotes().map((remote) => ({ ...remote, resolvedUrl: buildRemoteUrl(remote) }));
        return send(res, 200, { remotes });
      }

      if (u.pathname === '/remote' && req.method === 'GET') {
        const id = u.searchParams.get('id') || u.searchParams.get('name') || '';
        if (!id) return send(res, 400, { error: 'remote id or name required' });
        const remote = getRemote(id);
        if (!remote) return send(res, 404, { error: 'remote not found' });
        return send(res, 200, { remote: { ...remote, resolvedUrl: buildRemoteUrl(remote) } });
      }

      if (u.pathname === '/graph' && req.method === 'GET') {
        if (!cfg.obsidianVaultPath) return send(res, 400, { error: 'vault not configured' });
        try {
          const graph = buildVaultGraph(cfg.obsidianVaultPath);
          return send(res, 200, graph);
        } catch (e: any) {
          return send(res, 500, { error: e?.message || String(e) });
        }
      }

      if (u.pathname === '/note' && req.method === 'GET') {
        if (!cfg.obsidianVaultPath) return send(res, 400, { error: 'vault not configured' });
        const id = u.searchParams.get('id');
        if (!id) return send(res, 400, { error: 'id required' });
        const abs = path.resolve(cfg.obsidianVaultPath, id);
        if (!abs.startsWith(cfg.obsidianVaultPath)) return send(res, 400, { error: 'invalid path' });
        if (!fs.existsSync(abs) || !abs.toLowerCase().endsWith('.md')) return send(res, 404, { error: 'not found' });
        const text = fs.readFileSync(abs, 'utf-8');
        return send(res, 200, { id, path: abs, text });
      }

      if (u.pathname === '/open' && req.method === 'GET') {
        if (!cfg.obsidianVaultPath) return send(res, 400, { error: 'vault not configured' });
        const id = u.searchParams.get('id');
        if (!id) return send(res, 400, { error: 'id required' });
        const abs = path.resolve(cfg.obsidianVaultPath, id);
        if (!abs.startsWith(cfg.obsidianVaultPath)) return send(res, 400, { error: 'invalid path' });
        if (!fs.existsSync(abs)) return send(res, 404, { error: 'not found' });
        // macOS: use 'open' to reveal in default app / Finder
        execFile('open', [abs], (err) => {
          if (err) return send(res, 500, { error: String(err) });
          return send(res, 200, { ok: true });
        });
        return;
      }

      if (u.pathname === '/search' && req.method === 'POST') {
        if (!cfg.obsidianVaultPath) return send(res, 400, { error: 'vault not configured' });
        const body = await readJson(req);
        const q: string = (body?.q || '').toString();
        if (!q || q.length < 2) return send(res, 400, { error: 'query too short' });
        const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
        const results: { id: string; title: string; snippet: string; score: number }[] = [];
        const walk = (dir: string) => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === '.obsidian') continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
              const rel = path.relative(cfg.obsidianVaultPath!, full);
              const title = path.basename(full).replace(/\.md$/i, '');
              const text = fs.readFileSync(full, 'utf-8');
              const lower = text.toLowerCase();
              let score = 0;
              for (const t of terms) score += (lower.match(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
              if (score > 0) {
                const idx = lower.indexOf(terms[0]);
                const start = Math.max(0, idx - 80);
                const end = Math.min(text.length, (idx >= 0 ? idx : 0) + 160);
                const snippet = text.slice(start, end).replace(/\n/g, ' ');
                results.push({ id: rel, title, snippet, score });
              }
            }
          }
        };
        walk(cfg.obsidianVaultPath);
        results.sort((a, b) => b.score - a.score);
        return send(res, 200, { results: results.slice(0, 50) });
      }

      if (u.pathname === '/view' && req.method === 'GET') {
        const p = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public/index.html');
        try {
          const html = fs.readFileSync(p, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
        } catch {
          return send(res, 500, { error: 'viewer not found' });
        }
        return;
      }

      if (u.pathname === '/remote.html' && req.method === 'GET') {
        const p = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public/remote.html');
        try {
          const html = fs.readFileSync(p, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
        } catch {
          return send(res, 500, { error: 'remote session view not found' });
        }
        return;
      }

      if (u.pathname.startsWith('/static/')) {
        const rel = u.pathname.replace('/static/', '');
        const p = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public', rel);
        if (!fs.existsSync(p)) return send(res, 404, { error: 'static not found' });
        const ext = path.extname(p).toLowerCase();
        const type = ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'text/plain';
        res.writeHead(200, { 'Content-Type': type });
        fs.createReadStream(p).pipe(res);
        return;
      }

      if (u.pathname.startsWith('/workspace/')) {
        const rel = u.pathname.replace('/workspace/', '');
        const p = path.resolve(HOME_DIR, rel);
        if (!p.startsWith(HOME_DIR)) return send(res, 400, { error: 'invalid path' });
        if (!fs.existsSync(p)) return send(res, 404, { error: 'workspace file not found' });
        const stat = fs.statSync(p);
        if (stat.isDirectory()) {
          const indexPath = path.join(p, 'index.html');
          if (!fs.existsSync(indexPath)) return send(res, 404, { error: 'index.html not found' });
          const html = injectLiveReload(fs.readFileSync(indexPath, 'utf-8'), p);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }
        const type = contentTypeFor(p);
        if (p.toLowerCase().endsWith('.html')) {
          const html = injectLiveReload(fs.readFileSync(p, 'utf-8'), path.dirname(p));
          res.writeHead(200, { 'Content-Type': type });
          res.end(html);
          return;
        }
        res.writeHead(200, { 'Content-Type': type });
        fs.createReadStream(p).pipe(res);
        return;
      }

      return send(res, 404, { error: 'not found' });
    } catch (e: any) {
      return send(res, 500, { error: e?.message || String(e) });
    }
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}
