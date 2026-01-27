import fs from 'node:fs';

export type RawDoc = { id: string; path: string; content: string };

export function loadTextFile(p: string): string {
  return fs.readFileSync(p, 'utf-8');
}

export function simpleChunk(text: string, targetTokens = 900, overlap = 150): string[] {
  // naive token approx via words
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  let i = 0;
  while (i < words.length) {
    const end = Math.min(i + targetTokens, words.length);
    chunks.push(words.slice(i, end).join(' '));
    i = Math.max(end - overlap, end);
  }
  return chunks.filter(Boolean);
}

