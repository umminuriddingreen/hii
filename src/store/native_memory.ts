// Stores chat turns as JSONL in ~/.hii/memory/YYYY-MM-DD.jsonl
// Each line: { ts: string, prompt: string, answer: string, tools: string[] }

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface MemoryEntry {
  ts: string;
  prompt: string;
  answer: string;
  tools: string[];
}

export function memoryDir(): string {
  const dir = path.join(os.homedir(), ".hii", "memory");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function appendMemory(entry: MemoryEntry): void {
  const dir = memoryDir();
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const file = path.join(dir, `${date}.jsonl`);
  const line = JSON.stringify(entry) + "\n";
  fs.appendFileSync(file, line, "utf8");
}

export function loadRecentMemory(maxEntries: number = 30): MemoryEntry[] {
  const dir = memoryDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort()
    .reverse(); // newest-first

  const entries: MemoryEntry[] = [];

  for (const file of files) {
    if (entries.length >= maxEntries) break;
    const filePath = path.join(dir, file);
    const lines = fs
      .readFileSync(filePath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .reverse(); // newest lines first within file

    for (const line of lines) {
      if (entries.length >= maxEntries) break;
      try {
        const entry = JSON.parse(line) as MemoryEntry;
        entries.push(entry);
      } catch {
        // skip malformed lines
      }
    }
  }

  return entries;
}

export function searchMemory(
  query: string,
  maxResults: number = 20
): MemoryEntry[] {
  const dir = memoryDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort()
    .reverse();

  const lower = query.toLowerCase();
  const results: MemoryEntry[] = [];

  for (const file of files) {
    if (results.length >= maxResults) break;
    const filePath = path.join(dir, file);
    const lines = fs
      .readFileSync(filePath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .reverse();

    for (const line of lines) {
      if (results.length >= maxResults) break;
      try {
        const entry = JSON.parse(line) as MemoryEntry;
        if (
          entry.prompt.toLowerCase().includes(lower) ||
          entry.answer.toLowerCase().includes(lower)
        ) {
          results.push(entry);
        }
      } catch {
        // skip malformed lines
      }
    }
  }

  return results;
}

export function formatMemoryForContext(entries: MemoryEntry[]): string {
  return entries
    .map(
      (e) =>
        `[${e.ts}] user: ${e.prompt}\nassistant: ${e.answer}`
    )
    .join("\n\n");
}
