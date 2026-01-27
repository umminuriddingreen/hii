import http from 'node:http';
import { URL } from 'node:url';
import { loadConfig } from './config.js';
import { agentLoop } from './agent.js';
import { VectorStore } from './store/vectordb.js';
import { ingestPath } from './rag/ingest.js';

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

      if (u.pathname === '/chat' && req.method === 'POST') {
        const body = await readJson(req);
        const prompt: string = body?.prompt ?? '';
        if (!prompt) return send(res, 400, { error: 'prompt required' });
        const merged = { ...cfg, allowShell: !!(body?.allowShell ?? opts.allowShell ?? cfg.allowShell), allowSearch: !!(body?.allowSearch ?? opts.allowSearch ?? cfg.allowSearch) };
        const text = await agentLoop(merged, prompt, {
          webProvider: body?.webProvider ?? opts.webProvider,
          scholarly: !!(body?.scholarly ?? opts.scholarly),
          downloadPdfs: !!(body?.downloadPdfs ?? opts.downloadPdfs),
          useMemory: body?.memory ?? (opts.memory ?? cfg.memoryEnabled)
        });
        return send(res, 200, { text });
      }

      if (u.pathname === '/ingest' && req.method === 'POST') {
        const body = await readJson(req);
        const p: string = body?.path;
        if (!p) return send(res, 400, { error: 'path required' });
        const db = new VectorStore(cfg.dbPath);
        const count = await ingestPath(db, cfg.embedModel, p);
        return send(res, 200, { ok: true, chunks: count });
      }

      return send(res, 404, { error: 'not found' });
    } catch (e: any) {
      return send(res, 500, { error: e?.message || String(e) });
    }
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

