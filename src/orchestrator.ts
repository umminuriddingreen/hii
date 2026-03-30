import { chatWithConfig, type ChatMessage } from './clients/chat.js';
import { Config } from './config.js';
import { createEvent, HiiEvent } from './events.js';
import { appendMemory, loadRecentMemory, formatMemoryForContext } from './store/native_memory.js';
import { getMicroTool, microToolsSystemPrompt, runMicroTool } from './micro/index.js';
import { VectorStore } from './store/vectordb.js';
import { academicSearch, formatAcademic } from './tools/academic.js';
import { downloadPdf, ingestPdfToRag } from './tools/papers.js';
import { ragSearch } from './tools/rag.js';
import { webSearch } from './tools/search.js';
import { runShell } from './tools/shell.js';

type ToolResult = { name: string; content: string };
type SearchProvider = 'searxng' | 'serpapi' | 'duckduckgo';

export type IntentClass = 'execute' | 'ground' | 'plan' | 'clarify' | 'refuse';

export type OrchestratorOptions = {
  interactive?: boolean;
  webProvider?: SearchProvider;
  scholarly?: boolean;
  downloadPdfs?: boolean;
  useMemory?: boolean;
  autoGround?: boolean;
  history?: ChatMessage[];
};

export type OrchestratorResult = {
  text: string;
  messages: ChatMessage[];
  usedTools: string[];
  events: HiiEvent[];
  intent: IntentClass;
};

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i;
const TOOL_MAX_STEPS = 5;

function buildSystemPrompt(cfg: Config, opts?: OrchestratorOptions): string {
  const mode = opts?.interactive
    ? 'You are HII, a high-speed thought sharpening CLI and deterministic execution layer. Push the user toward clearer framing, cleaner decomposition, and falsifiable reasoning.'
    : 'You are HII, a concise local execution CLI.';

  return [
    mode,
    'Operate as an execution system, not a chat companion.',
    'Be direct. Prefer short, high-signal answers.',
    'When a claim depends on changing or externally sourced facts, use web_search before answering if search is available.',
    'When the user asks about local code, notes, or files, use rag_search if it would improve precision.',
    'When the user explicitly asks to run a command and shell access is enabled, use shell.',
    'If you need a tool, respond with only a single XML block in this exact form:',
    '<tool_call>{"name":"web_search","query":"..."}</tool_call>',
    'Core tools: web_search, rag_search, shell, academic_search, rhino_capture.',
    'rhino_capture captures the Rhino viewport as PNG. Args: width, height, output.',
    microToolsSystemPrompt(),
    'If no tool is needed, answer normally.',
    `Shell enabled: ${cfg.allowShell}. Search enabled: ${cfg.allowSearch}. Offline mode: ${cfg.offline}.`,
  ].join('\n');
}

function shouldGround(prompt: string): boolean {
  return /\b(latest|recent|today|current|news|price|stock|score|ceo|president|release date|version|status|what happened|who is|weather|when is)\b/i.test(prompt);
}

function classifyIntent(prompt: string, cfg: Config, opts?: OrchestratorOptions): IntentClass {
  const text = prompt.trim().toLowerCase();
  if (!text) return 'clarify';
  if (/\b(delete|wipe|destroy|format|drop database|rm -rf)\b/.test(text) && !cfg.allowShell) return 'clarify';
  if (/\b(refuse|bypass|steal|hack|malware|credential|phish)\b/.test(text)) return 'refuse';
  if (cfg.allowSearch && !cfg.offline && (opts?.autoGround ?? true) && shouldGround(prompt)) return 'ground';
  if (/\b(plan|roadmap|strategy|architecture|design)\b/.test(text)) return 'plan';
  if (text.split(/\s+/).length <= 2) return 'clarify';
  return 'execute';
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

async function runToolCall(
  cfg: Config,
  prompt: string,
  toolCall: { name: string; args: Record<string, any> },
  opts: OrchestratorOptions | undefined,
): Promise<ToolResult> {
  // Micro tools dispatch first
  const micro = getMicroTool(toolCall.name);
  if (micro) {
    const content = await runMicroTool(toolCall.name, toolCall.args);
    return { name: toolCall.name, content };
  }

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
    case 'rhino_capture': {
      const width = Number(toolCall.args.width) || 1920;
      const height = Number(toolCall.args.height) || 1080;
      const output = String(toolCall.args.output || '/tmp/hii-rhino-capture.png');
      const { code, stdout, stderr } = await runShell(
        `python3 ~/hii/scripts/rhino_capture_viewport.py --width ${width} --height ${height} --output "${output}"`
      );
      if (code !== 0) return { name: 'rhino_capture', content: `Capture failed: ${stderr}` };
      return { name: 'rhino_capture', content: stdout };
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
          } catch {
            // ignore per-item pdf failures
          }
        }
      }
      return { name: 'academic_search', content: formatAcademic(items) };
    }
    default:
      return { name: toolCall.name, content: `Unknown tool: ${toolCall.name}` };
  }
}

export async function orchestrateIntent(cfg: Config, prompt: string, opts?: OrchestratorOptions): Promise<OrchestratorResult> {
  const events: HiiEvent[] = [];
  const emit = (type: HiiEvent['type'], data: Record<string, unknown> = {}) => {
    const event = createEvent(type, data);
    events.push(event);
    return event;
  };

  emit('intent.received', { prompt });
  const intent = classifyIntent(prompt, cfg, opts);
  emit('intent.classified', { intent });

  if (intent === 'refuse') {
    const text = 'Request refused.';
    emit('response.completed', { intent, usedTools: [], text });
    return { text, messages: [], usedTools: [], events, intent };
  }

  const messages: ChatMessage[] = opts?.history ? [...opts.history] : [];
  if (!messages.some((message) => message.role === 'system')) {
    messages.unshift({ role: 'system', content: buildSystemPrompt(cfg, opts) });
  }

  const toolResults: ToolResult[] = [];

  // Native memory injection
  if (opts?.useMemory ?? cfg.memoryEnabled) {
    try {
      const entries = loadRecentMemory(cfg.memoryMaxEntries || 30);
      if (entries.length > 0) {
        const memCtx = formatMemoryForContext(entries);
        messages.push({ role: 'system', content: `Recent memory context:\n${memCtx}` });
        toolResults.push({ name: 'memory', content: 'Loaded recent memory context.' });
        emit('memory.loaded', { entries: entries.length });
      }
    } catch (error: any) {
      emit('blocker.detected', { stage: 'memory', message: error?.message || String(error) });
    }
  }

  messages.push({ role: 'user', content: prompt });

  if (intent === 'ground') {
    emit('grounding.started', { provider: opts?.webProvider || 'searxng', query: prompt });
    const grounded = await webSearch(prompt, opts?.webProvider);
    messages.push({ role: 'tool', content: `[web_search]\n${grounded}` });
    toolResults.push({ name: 'web_search', content: grounded });
    emit('grounding.finished', { provider: opts?.webProvider || 'searxng', query: prompt });
  }

  let finalText = '';
  for (let step = 0; step < TOOL_MAX_STEPS; step += 1) {
    const { text } = await chatWithConfig(cfg, messages, { temperature: 0.2 });
    const toolCall = parseToolCall(text);
    if (!toolCall) {
      finalText = text;
      messages.push({ role: 'assistant', content: text });
      break;
    }

    emit('tool.selected', { name: toolCall.name });
    emit('tool.started', { name: toolCall.name });
    const toolResult = await runToolCall(cfg, prompt, toolCall, opts);
    emit('tool.finished', { name: toolResult.name });
    toolResults.push(toolResult);
    messages.push({ role: 'assistant', content: text });
    messages.push({ role: 'tool', content: `[${toolResult.name}]\n${toolResult.content}` });
  }

  if (!finalText) {
    const { text } = await chatWithConfig(cfg, messages, { temperature: 0.2 });
    finalText = text;
    messages.push({ role: 'assistant', content: text });
  }

  // Persist to native memory
  if (opts?.useMemory ?? cfg.memoryEnabled) {
    try {
      appendMemory({
        ts: new Date().toISOString(),
        prompt,
        answer: finalText,
        tools: toolResults.map((t) => t.name).filter((n) => n !== 'memory'),
      });
    } catch (error: any) {
      emit('blocker.detected', { stage: 'memory.write', message: error?.message || String(error) });
    }
  }

  const usedTools = [...new Set(toolResults.map((tool) => tool.name))];
  emit('response.completed', { intent, usedTools, text: finalText });
  return {
    text: finalText,
    messages,
    usedTools,
    events,
    intent,
  };
}
