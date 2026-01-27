import fs from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';
import pdfParse from 'pdf-parse';
import { VectorStore } from '../store/vectordb.js';
import { embed } from '../clients/ollama.js';
import { simpleChunk } from '../rag/chunk.js';

export type OAItem = { title: string; url: string };

export function ensurePapersDir(root = process.cwd()): string {
  const dir = path.resolve(root, 'papers');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(name: string): string {
  return name.replace(/[^a-z0-9\-_.]+/gi, '_').slice(0, 200);
}

export async function downloadPdf(url: string, title = 'paper', root = process.cwd(), maxBytes = 25 * 1024 * 1024): Promise<string> {
  const papersDir = ensurePapersDir(root);
  const file = path.join(papersDir, `${safeName(title)}.pdf`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status}`);
  const ws = fs.createWriteStream(file);
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    res.body.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        res.body?.destroy(new Error('PDF too large'));
        ws.destroy(new Error('PDF too large'));
        reject(new Error('PDF too large'));
      }
    });
    res.body.pipe(ws);
    ws.on('finish', () => resolve());
    ws.on('error', reject);
  });
  return file;
}

export async function extractPdfText(pdfPath: string): Promise<string> {
  const data = await pdfParse(fs.readFileSync(pdfPath));
  return data.text || '';
}

export async function ingestPdfToRag(db: VectorStore, embedModel: string, pdfPath: string): Promise<number> {
  await db.init();
  const text = await extractPdfText(pdfPath);
  if (!text.trim()) return 0;
  const chunks = simpleChunk(text, 900, 150);
  const vectors = await embed(embedModel, chunks);
  const items = chunks.map((content, idx) => ({
    id: `${pdfPath}#${idx}`,
    docId: pdfPath,
    path: pdfPath,
    content,
    meta: { idx, type: 'pdf' },
    embedding: vectors[idx]
  }));
  await db.upsert(items);
  return items.length;
}

