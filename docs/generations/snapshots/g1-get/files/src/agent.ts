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
type SearchProvider = 'searxng' | 'serpapi' | 'duckduckgo';

export type AgentLoopOptions = {
  interactive?: boolean;
  webProvider?: SearchProvider;
  scholarly?: boolean;
  downloadPdfs?: boolean;
  useMemory?: boolean;
  autoGround?: boolean;
  history?: OllamaMessage[];
};

export type AgentTurnResult = {
  text: string;
  messages: OllamaMessage[];
  usedTools: string[];
};

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i;
const TOOL_MAX_STEPS = 3;

function buildSystemPrompt(cfg: Config, opts?: AgentLoopOptions): string {
  const mode = opts?.interactive
    ? 'You are HII, a high-speed thought sharpening CLI. Push the user toward clearer framing, cleaner decomposition, and falsifiable reasoning.'
    : 'You are HII, a concise local CLI assistant.';

  return [
    mode,
    'Be direct. Prefer short, high-signal answers.',
    'When a claim depends on changing or externally sourced facts, use web_search before answering if search is available.',
    'When the user asks about local code, notes, or files, use rag_search if it would improve precision.',
    'When the user explicitly asks to run a command and shell access is enabled, use shell.',
    'If you need a tool, respond with only a single XML block in this exact form:',
    '<tool_call>{"name":"web_search","query":"..."}</tool_call>',
    'Supported tools: web_search, rag_search, shell, academic_search.',
    'If no tool is needed, answer normally.',
    `Shell enabled: ${cfg.allowShell}. Search enabled: ${cfg.allowSearch}. Offline mode: ${cfg.offline}.`,
  ].join('\n');
}

function shouldGround(prompt: string): boolean {
  return /\b(latest|recent|today|current|news|price|stock|score|ceo|president|release date|version|status|what happened|who is|weather|when is)\b/i.test(prompt);
}

function parseToolCall(text: string): { name: string; args: Record<string, any> } | null {
  const match = text.match(TOOL_CALL_RE);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed?.name || typeof parsed.name !== 'string') return null;
    return { name: parsed.name, args: parsed };
  } catch {
    return null;
  }
}

async function runToolCall(cfg: Config, prompt: string, toolCall: { name: string; args: Record<string, any> }, opts?: AgentLoopOptions): Promise<ToolResult> {
  switch (toolCall.name) {
    case 'web_search': {
      if (!cfg.allowSearch || cfg.offline) {
        return { name: 'web_search', content: 'Web search unavailable: search is disabled or offline mode is enabled.' };
      }
      const query = String(toolCall.args.query || prompt).trim();
      return { name: 'web_search', content: await webSearch(query, opts?.webProvider) };
    }
    case 'rag_search': {
      const query = String(toolCall.args.query || prompt).trim();
      const db = new VectorStore(cfg.dbPath);
      const res = await ragSearch(db, cfg.embedModel, query, Number(toolCall.args.k) || 5);
      return {
        name: 'rag_search',
        content: res.map((r) => `# ${r.path}\n${r.content}`).join('\n---\n') || 'No results',
      };
    }
    case 'shell': {
      if (!cfg.allowShell) return { name: 'shell', content: 'Shell unavailable: enable with --shell.' };
      const cmd = String(toolCall.args.command || toolCall.args.cmd || '').trim();
      if (!cmd) return { name: 'shell', content: 'Shell command missing.' };
      const { code, stdout, stderr } = await runShell(cmd);
      return { name: 'shell', content: `code=${code}\nstdout\n${stdout}\nstderr\n${stderr}` };
    }
    case 'academic_search': {
      if (!cfg.allowSearch || cfg.offline) {
        return { name: 'academic_search', content: 'Academic search unavailable: search is disabled or offline mode is enabled.' };
      }
      const query = String(toolCall.args.query || prompt).trim();
      const items = await academicSearch(query, Number(toolCall.args.limit) || 10);
      if (opts?.downloadPdfs) {
        const db = new VectorStore(cfg.dbPath);
        for (const item of items.slice(0, 3)) {
          try {
            const pdfUrl = item.url && /\.pdf($|\?)/i.test(item.url) ? item.url : '';
            if (!pdfUrl) continue;
            const file = await downloadPdf(pdfUrl, item.title);
            await ingestPdfToRag(db, cfg.embedModel, file);
          } catch {}
        }
      }
      return { name: 'academic_search', content: formatAcademic(items) };
    }
    default:
      return { name: toolCall.name, content: `Unknown tool: ${toolCall.name}` };
  }
}

export async function agentTurn(cfg: Config, prompt: string, opts?: AgentLoopOptions): Promise<AgentTurnResult> {
  const messages: OllamaMessage[] = opts?.history ? [...opts.history] : [];
  if (!messages.some((message) => message.role === 'system')) {
    messages.unshift({ role: 'system', content: buildSystemPrompt(cfg, opts) });
  }

  const toolResults: ToolResult[] = [];

  if ((opts?.useMemory ?? cfg.memoryEnabled) && isVaultUsable(cfg.obsidianVaultPath)) {
    try {
      const mem = loadRecentEntries(cfg.obsidianVaultPath!, cfg.memoryMaxEntries || 20);
      if (mem?.content) {
        messages.push({
          role: 'system',
          content: `Recent memory context:\n${mem.content}`,
        });
        toolResults.push({ name: 'memory', content: 'Loaded recent memory context.' });
      }
    } catch {}
  }

  messages.push({ role: 'user', content: prompt });

  if (cfg.allowSearch && !cfg.offline && (opts?.autoGround ?? true) && shouldGround(prompt)) {
    const grounded = await webSearch(prompt, opts?.webProvider);
    messages.push({ role: 'tool', content: `[web_search]\n${grounded}` });
    toolResults.push({ name: 'web_search', content: grounded });
  }

  let finalText = '';

  for (let step = 0; step < TOOL_MAX_STEPS; step += 1) {
    const { text } = await chat(cfg.baseModel, messages, { temperature: 0.2 });
    const toolCall = parseToolCall(text);
    if (!toolCall) {
      finalText = text;
      messages.push({ role: 'assistant', content: text });
      break;
    }

    const toolResult = await runToolCall(cfg, prompt, toolCall, opts);
    toolResults.push(toolResult);
    messages.push({ role: 'assistant', content: text });
    messages.push({ role: 'tool', content: `[${toolResult.name}]\n${toolResult.content}` });
  }

  if (!finalText) {
    const { text } = await chat(cfg.baseModel, messages, { temperature: 0.2 });
    finalText = text;
    messages.push({ role: 'assistant', content: text });
  }

  if ((opts?.useMemory ?? cfg.memoryEnabled) && isVaultUsable(cfg.obsidianVaultPath)) {
    try {
      appendChat(cfg.obsidianVaultPath!, prompt, finalText, toolResults.map((tool) => tool.name));
    } catch {}
  }

  return {
    text: finalText,
    messages,
    usedTools: [...new Set(toolResults.map((tool) => tool.name))],
  };
}

export async function agentLoop(cfg: Config, prompt: string, opts?: AgentLoopOptions): Promise<string> {
  const result = await agentTurn(cfg, prompt, opts);
  return result.text;
}
