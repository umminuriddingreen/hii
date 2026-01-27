import fs from 'node:fs';
import path from 'node:path';

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

export function isVaultUsable(vaultPath?: string): boolean {
  return !!(vaultPath && typeof vaultPath === 'string' && vaultPath.length > 1);
}

export function checkVault(vaultPath: string): { exists: boolean; hasObsidian: boolean; obsidianDir: string } {
  const exists = fs.existsSync(vaultPath);
  const obsidianDir = path.join(vaultPath, '.obsidian');
  const hasObsidian = exists && fs.existsSync(obsidianDir);
  return { exists, hasObsidian, obsidianDir };
}

export function entryFileForDate(vaultPath: string, d = new Date()): string {
  const dir = path.join(vaultPath, 'Chats');
  ensureDir(dir);
  const iso = d.toISOString().slice(0, 10);
  return path.join(dir, `${iso}.md`);
}

export function appendChat(vaultPath: string, prompt: string, answer: string, tools?: string[]): void {
  const file = entryFileForDate(vaultPath);
  const ts = new Date().toISOString();
  const header = fs.existsSync(file) ? '' : `---\ncreated: ${ts}\n---\n\n# Chat Log ${path.basename(file)}\n\n`;
  const toolLine = tools && tools.length ? `\n**Tools:** ${tools.join(', ')}\n` : '';
  const block = `\n## ${ts}\n\n**Prompt:**\n\n${prompt}\n\n**Answer:**\n\n${answer}${toolLine}`;
  fs.appendFileSync(file, header + block);
}

export function loadRecentEntries(vaultPath: string, maxEntries = 20): { role: 'memory'; content: string } | null {
  const chatsDir = path.join(vaultPath, 'Chats');
  if (!fs.existsSync(chatsDir)) return null;
  const files = fs.readdirSync(chatsDir).filter(f => f.endsWith('.md')).sort().reverse();
  const entries: string[] = [];
  for (const f of files) {
    const full = path.join(chatsDir, f);
    const text = fs.readFileSync(full, 'utf-8');
    const parts = text.split(/^##\s+/m).filter(x => x.trim());
    for (let i = parts.length - 1; i >= 0; i--) {
      const chunk = parts[i].trim();
      if (chunk) entries.push(chunk);
      if (entries.length >= maxEntries) break;
    }
    if (entries.length >= maxEntries) break;
  }
  if (!entries.length) return null;
  const content = entries.slice(0, maxEntries).reverse().join('\n\n---\n\n');
  return { role: 'memory', content };
}
