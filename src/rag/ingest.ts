import path from 'node:path';
import fs from 'node:fs';
import { simpleChunk } from './chunk.js';
import { VectorStore, DocChunk } from '../store/vectordb.js';
import { embed } from '../clients/ollama.js';

const TEXT_EXT = new Set(['.md', '.txt', '.js', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.json', '.yaml', '.yml']);

function collectFiles(root: string): string[] {
  const results: string[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
        walk(full);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (TEXT_EXT.has(ext)) results.push(full);
      }
    }
  }
  walk(root);
  return results;
}

export async function ingestPath(db: VectorStore, embedModel: string, root: string): Promise<number> {
  await db.init();
  const files = collectFiles(root);
  let count = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf-8');
    const chunks = simpleChunk(text);
    const embeddings = await embed(embedModel, chunks);
    const toUpsert: DocChunk[] = chunks.map((content, idx) => ({
      id: `${file}#${idx}`,
      docId: file,
      path: file,
      content,
      meta: { idx },
      embedding: embeddings[idx]
    }));
    await db.upsert(toUpsert);
    count += toUpsert.length;
  }
  return count;
}

