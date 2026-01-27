import { chat, OllamaMessage } from './clients/ollama.js';
import { VectorStore } from './store/vectordb.js';
import { ragSearch } from './tools/rag.js';
import { runShell } from './tools/shell.js';
import { webSearch } from './tools/search.js';
import { Config } from './config.js';

type ToolResult = { name: string; content: string };

export async function agentLoop(cfg: Config, prompt: string, opts?: { interactive?: boolean }) {
  const messages: OllamaMessage[] = [
    { role: 'system', content: 'You are a local agent. Use tools when user asks for file lookup, shell, or web. Keep answers concise.' },
    { role: 'user', content: prompt }
  ];

  // very simple loop: check for tool keywords and call directly
  const lower = prompt.toLowerCase();
  const toolResults: ToolResult[] = [];

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
    const content = await webSearch(q || prompt);
    toolResults.push({ name: 'web', content });
  }

  if (toolResults.length) {
    messages.push({ role: 'tool', content: toolResults.map(t => `[${t.name}]\n${t.content}`).join('\n\n') });
  }

  const { text } = await chat(cfg.baseModel, messages, { temperature: 0.2 });
  return text;
}

