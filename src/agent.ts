import { chat, OllamaMessage } from './clients/ollama.js';
import { VectorStore } from './store/vectordb.js';
import { ragSearch } from './tools/rag.js';
import { runShell } from './tools/shell.js';
import { webSearch } from './tools/search.js';
import { academicSearch, formatAcademic } from './tools/academic.js';
import { Config } from './config.js';
import { isVaultUsable, loadRecentEntries, appendChat } from './memory.js';
import { ingestPdfToRag, downloadPdf } from './tools/papers.js';

type ToolResult = { name: string; content: string };

type StructuredToolCall = { name: string; args: any };

export async function agentLoop(cfg: Config, prompt: string, opts?: { interactive?: boolean, webProvider?: 'serpapi'|'duckduckgo', scholarly?: boolean, downloadPdfs?: boolean, useMemory?: boolean }) {
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'You are a local agent. Use tools when user asks for file lookup, shell, or web. Keep answers concise.' },
    { role: 'user', content: prompt }
  ];

  // very simple loop: check for tool keywords and call directly
  const lower = prompt.toLowerCase();
  const toolResults: ToolResult[] = [];

  // Memory recall from Obsidian vault
  if ((opts?.useMemory ?? cfg.memoryEnabled) && isVaultUsable(cfg.obsidianVaultPath)) {
    try {
      const mem = loadRecentEntries(cfg.obsidianVaultPath!, cfg.memoryMaxEntries || 20);
      if (mem) {
        toolResults.push({ name: 'memory', content: mem.content });
      }
    } catch {}
  }

  if (lower.includes('search files') || lower.includes('rag') || lower.includes('lookup')) {
    const db = new VectorStore(cfg.dbPath);
    const res = await ragSearch(db, cfg.embedModel, prompt, 5);
    toolResults.push({ name: 'rag', content: res.map(r => `# ${r.path}\n${r.content}`).join('\n---\n') || 'No results' });
  }

  if (cfg.allowShell && (lower.startsWith('run ') || lower.includes('shell:'))) {
    const cmd = prompt.replace(/^run\s+/i, '').replace(/^shell:\s*/i, '');
    const { code, stdout, stderr } = await runShell(cmd);
    toolResults.push({ name: 'shell', content: `code=${code}\nstdout\n${stdout}\nstderr\n${stderr}` });
  }

  if (cfg.allowSearch && (lower.includes('search web') || lower.includes('web:'))) {
    const q = prompt.replace(/^.*?(search web|web:)\s*/i, '');
    const content = await webSearch(q || prompt, opts?.webProvider);
    toolResults.push({ name: 'web', content });
  }

  const scholarlyIntent = opts?.scholarly || /(peer[- ]?review|paper|citation|doi|arxiv|openalex|crossref|literature review|systematic review|journal|conference|book)/i.test(prompt);
  if (cfg.allowSearch && scholarlyIntent) {
    const items = await academicSearch(prompt, 10);
    toolResults.push({ name: 'academic', content: formatAcademic(items) });
    if (opts?.downloadPdfs) {
      const oaLinks = items.map(it => {
        let url = it.url;
        if (it.source === 'arxiv') {
          const m = (it.id || it.url).match(/arxiv\.org\/abs\/([^<\s]+)/);
          if (m) url = `https://arxiv.org/pdf/${m[1]}.pdf`;
        }
        return { title: it.title, url };
      }).filter(x => x.url && /\.pdf($|\?)/i.test(x.url));
      const db = new VectorStore(cfg.dbPath);
      for (const oa of oaLinks.slice(0, 3)) {
        try {
          const p = await downloadPdf(oa.url, oa.title);
          await ingestPdfToRag(db, cfg.embedModel, p);
        } catch {}
      }
    }
  }

  if (toolResults.length) {
    messages.push({ role: 'tool', content: toolResults.map(t => `[${t.name}]\n${t.content}`).join('\n\n') });
  }

  const { text } = await chat(cfg.baseModel, messages, { temperature: 0.2 });

  // Persist chat to Obsidian vault
  if ((opts?.useMemory ?? cfg.memoryEnabled) && isVaultUsable(cfg.obsidianVaultPath)) {
    try {
      const usedTools = toolResults.map(t => t.name);
      appendChat(cfg.obsidianVaultPath!, prompt, text, usedTools);
    } catch {}
  }

  return text;
}
