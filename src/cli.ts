#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig, saveConfig } from './config.js';
import { VectorStore } from './store/vectordb.js';
import { ingestPath } from './rag/ingest.js';
import { agentLoop, agentTurn } from './agent.js';
import { addApp, appsSummary, getApp, listApps, updateApp } from './apps.js';
import { codexPaths, createCodexDoc, createWorkspaceCodex, getCodexDoc, listCodexDocs, searchCodexDocs } from './codex.js';
import { formatDualMessages, initDuality, postDualMessage, readDualMessages } from './duality.js';
import { appendConversationTurn, conversationPaths, conversationSummary, formatConversationEntries, listConversationTranscripts, readConversationTranscript, readRecentConversationEntries } from './conversations.js';
import { runAgentBrowser } from './tools/browser.js';
import {
  balanceSpaceSizes,
  focusSpaceMonitor,
  focusSpaceWindow,
  getSpaceHealth,
  getSpaceSnapshot,
  listSpaceApps,
  moveSpaceWindowToWorkspace,
  moveSpaceWorkspaceToMonitor,
  reloadSpaceConfig,
  switchSpaceWorkspace,
} from './tools/space.js';
import { webSearch } from './tools/search.js';
import { runShell } from './tools/shell.js';
import { createGenerationSnapshot, currentGeneration, formatGenerationDetail, formatGenerationSummary, generationPaths, getGeneration, listGenerations } from './generations.js';
import { getHiiHealth } from './health.js';
import { addRemote, addSshRemote, buildRemoteUrl, execSshRemote, getRemote, getSshRemote, openRemote, remoteSummary, sshRemoteSummary, testSshRemote } from './remote.js';
import type { ChatMessage } from './clients/chat.js';
import { resolveChatBackend, resolveChatModel } from './clients/chat.js';
import { listAllModels, modelsToMenuItems } from './clients/models.js';
import { interactiveMenu } from './tui/menu.js';
import { slashMenu } from './tui/slash-menu.js';
import { microTools } from './micro/index.js';

const program = new Command();
program
  .name('hii')
  .description('Local agentic CLI powered by Codex')
  .version('0.1.0')
  .showSuggestionAfterError(true)
  .showHelpAfterError('(run with --help for usage)');

const CHAT_SLASH_COMMANDS = [
  '/help',
  '/exit',
  '/quit',
  '/clear',
  '/model',
  '/status',
  '/search',
  '/web',
  '/ground',
  '/memory',
  '/models',
  '/generate',
  '/tools',
] as const;

const HII_LOGO = String.raw`
  _     _ _
 | |__ (_) |_
 | '_ \| | __|
 | | | | | |_
 |_| |_|_|\__|
`;

const HII_LOGO_BITMAP = [
  '##  ##  ####  ####',
  '##  ##   ##    ## ',
  '######   ##    ## ',
  '##  ##   ##    ## ',
  '##  ##  ####  ####',
];

let logoAnimationTimer: NodeJS.Timeout | undefined;
let logoAnimationPhase = 0;

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const next = new Array<number>(b.length + 1);
  for (let i = 0; i < a.length; i += 1) {
    next[0] = i + 1;
    for (let j = 0; j < b.length; j += 1) {
      const cost = a[i] === b[j] ? 0 : 1;
      next[j + 1] = Math.min(
        next[j] + 1,
        prev[j + 1] + 1,
        prev[j] + cost,
      );
    }
    for (let j = 0; j < next.length; j += 1) prev[j] = next[j];
  }
  return prev[b.length];
}

function commandNames(cmd: Command): string[] {
  const names = [cmd.name()];
  const alias = cmd.alias();
  if (alias) names.push(alias);
  return names.filter(Boolean);
}

function resolveCommandToken(token: string, commands: readonly Command[]): string | null {
  const normalized = token.toLowerCase();
  const choices = commands.map((cmd) => ({
    primary: cmd.name(),
    names: commandNames(cmd).map((name) => name.toLowerCase()),
  }));
  const exact = choices.find((choice) => choice.names.includes(normalized));
  if (exact) return exact.primary;

  const prefixMatches = choices.filter((choice) => choice.names.some((name) => name.startsWith(normalized)));
  if (prefixMatches.length === 1) return prefixMatches[0].primary;

  const ranked = choices
    .map((choice) => ({
      primary: choice.primary,
      distance: Math.min(...choice.names.map((name) => levenshtein(normalized, name))),
    }))
    .sort((a, b) => a.distance - b.distance || a.primary.localeCompare(b.primary));

  const best = ranked[0];
  const second = ranked[1];
  if (!best) return null;
  const strongMatch = best.distance <= 2 || (normalized.length >= 5 && best.distance <= 3);
  const clearlyBetter = !second || best.distance + 1 <= second.distance;
  return strongMatch && clearlyBetter ? best.primary : null;
}

function normalizeCliArgv(root: Command, argv: string[]): string[] {
  if (argv.length <= 2) return [...argv, 'serve'];
  const normalized = [...argv];
  const firstToken = normalized[2];
  if (firstToken && !firstToken.startsWith('-')) {
    const firstResolved = resolveCommandToken(firstToken, root.commands);
    if (!firstResolved) {
      const looksLikePrompt = firstToken.includes(' ') || normalized.length > 3;
      if (looksLikePrompt) {
        normalized.splice(2, 0, 'chat');
        return normalized;
      }
      return normalized;
    }
    normalized[2] = firstResolved;
  }
  let current = root;
  let index = 2;

  while (index < normalized.length) {
    const token = normalized[index];
    if (!token || token.startsWith('-')) break;
    if (!current.commands.length) break;

    const resolved = resolveCommandToken(token, current.commands);
    if (!resolved) break;

    normalized[index] = resolved;
    const next = current.commands.find((cmd) => cmd.name() === resolved);
    if (!next) break;
    current = next;
    index += 1;
  }

  return normalized;
}

function completeChatLine(line: string): [string[], string] {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('/')) return [[], line];

  const parts = trimmed.split(/\s+/);
  const command = parts[0] || '';
  const expectingValue = /\s$/.test(trimmed);

  if (parts.length <= 1 && !expectingValue) {
    const hits = CHAT_SLASH_COMMANDS.filter((item) => item.startsWith(command));
    return [hits.length ? hits : [...CHAT_SLASH_COMMANDS], command];
  }

  const valueStem = expectingValue ? '' : parts[parts.length - 1];
  const boolValues = ['on', 'off'];
  if (command === '/web' || command === '/ground' || command === '/memory') {
    const hits = boolValues.filter((value) => value.startsWith(valueStem));
    return [hits.length ? hits : boolValues, valueStem];
  }
  if (command === '/search') {
    return [['<query>'], valueStem];
  }
  if (command === '/model') {
    return [['<model-name>'], valueStem];
  }
  if (command === '/help') {
    return [[], valueStem];
  }
  return [[], valueStem];
}

function printLogo() {
  console.log(HII_LOGO);
}

function renderAnimatedLogoFrame(phase: number): string {
  const palette = [' ', '.', ':', '-', '=', '+', '*', '#', '%', '@'];
  const lines: string[] = [];
  for (let y = 0; y < HII_LOGO_BITMAP.length; y += 1) {
    const row = HII_LOGO_BITMAP[y];
    let line = '';
    const lead = Math.round(Math.sin(phase * 0.9 + y * 0.55) * 3 + 3);
    line += ' '.repeat(Math.max(0, lead));
    for (let x = 0; x < row.length; x += 1) {
      const cell = row[x];
      if (cell === ' ') {
        line += ' ';
        continue;
      }
      const depth = Math.sin((x * 0.42) + phase) + Math.cos((y * 0.75) - phase * 1.3);
      const index = Math.max(3, Math.min(palette.length - 1, Math.round(((depth + 2) / 4) * (palette.length - 1))));
      line += palette[index];
    }
    lines.push(line);
  }
  return lines.join('\n');
}

async function printAnimatedLogo() {
  if (!output.isTTY || process.env.CI === 'true') {
    printLogo();
    return;
  }
  if (logoAnimationTimer) return;

  const render = () => {
    const frame = renderAnimatedLogoFrame(logoAnimationPhase)
      .split('\n')
      .map((line) => `\x1B[2K${line}`)
      .join('\n');
    output.write('\x1B[s');
    output.write(`\x1B[${HII_LOGO_BITMAP.length + 4}F`);
    output.write(frame);
    output.write('\x1B[u');
    logoAnimationPhase += 0.65;
  };

  render();
  logoAnimationTimer = setInterval(render, 90);
  if (typeof logoAnimationTimer.unref === 'function') {
    logoAnimationTimer.unref();
  }
}

async function maybeHandleBrowserPassthrough() {
  if (process.argv[2] !== 'browser') return false;
  const args = process.argv.slice(3);
  try {
    const result = await runAgentBrowser(args, { stdio: 'inherit' });
    process.exit(result.code ?? 1);
  } catch (error: any) {
    console.error(error?.message || String(error));
    process.exit(1);
  }
}

async function printChatBanner() {
  await printAnimatedLogo();
  console.log('High-speed thought sharpening. Search grounding is available through SearxNG when web is enabled.');
  console.log('Commands: /help, /exit, /clear, /status, /models, /generate, /capture, /model, /search, /web, /ground, /memory');
  console.log('Tab completes slash commands and toggle values.');
  console.log('');
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const tenths = Math.floor((ms % 1000) / 100);
  return `${seconds}.${tenths}s`;
}

async function withLoadingIndicator<T>(label: string, task: () => Promise<T>): Promise<T> {
  if (!output.isTTY || process.env.CI === 'true') return task();
  const frames = ['|', '/', '-', '\\', '▃', '▄', '▅', '▆', '▇', '█'];
  const started = Date.now();
  let frame = 0;
  let timer: NodeJS.Timeout | undefined;

  const render = () => {
    const elapsed = formatElapsed(Date.now() - started);
    const prefix = frames[frame % frames.length];
    output.write(`\r${prefix} ${label} ${elapsed}`);
    frame += 1;
  };

  render();
  timer = setInterval(render, 80);

  try {
    const result = await task();
    clearInterval(timer);
    output.write(`\r✓ ${label} ${formatElapsed(Date.now() - started)}\n`);
    return result;
  } catch (error) {
    clearInterval(timer);
    output.write(`\r✗ ${label} ${formatElapsed(Date.now() - started)}\n`);
    throw error;
  }
}

program.addHelpText('before', `${HII_LOGO}\n`);

program.command('health')
  .description('Show a compact operational health report for HII')
  .action(async () => {
    console.log(JSON.stringify(await getHiiHealth(), null, 2));
  });

async function runInteractiveChat(opts: any) {
  const cfg = loadConfig();
  const merged = { ...cfg, allowShell: !!opts.shell, allowSearch: !!opts.web, offline: !opts.online };
  if (opts.memoryEntries !== 'auto') merged.memoryMaxEntries = Number(opts.memoryEntries) || merged.memoryMaxEntries;
  const provider = opts.webProvider === 'auto' ? 'searxng' : opts.webProvider;
  let rl = readline.createInterface({ input, output, completer: completeChatLine });
  const history: ChatMessage[] = [];
  let autoGround = true;
  let useMemory = !opts.noMemory;

  await printChatBanner();

  // Non-blocking update check
  runShell('git -C ~/hii rev-list HEAD..origin/main --count 2>/dev/null').then(({ code, stdout }) => {
    if (code === 0) {
      const n = parseInt(stdout.trim(), 10);
      if (n > 0) console.log(`(${n} update${n > 1 ? 's' : ''} available — run hii update)\n`);
    }
  }).catch(() => {});

  let nextCommand: string | null = null;

  try {
    while (true) {
      let raw: string;
      if (nextCommand) {
        raw = nextCommand;
        nextCommand = null;
      } else {
        raw = (await rl.question('› ')).trim();
        if (!raw) continue;
      }

      if (raw === '/exit' || raw === '/quit') break;

      // Bare "/" opens the interactive slash menu
      if (raw === '/') {
        rl.close();
        const picked = await slashMenu();
        rl = readline.createInterface({ input, output, completer: completeChatLine });
        if (!picked) continue;
        // If command expects an argument (trailing space), prompt for it
        if (picked.endsWith(' ')) {
          const arg = (await rl.question(`${picked}`)).trim();
          nextCommand = arg ? `${picked}${arg}` : picked.trimEnd();
        } else {
          nextCommand = picked;
        }
        continue;
      }

      if (raw === '/help') {
        console.log('`/status` shows the active backend and model.');
        console.log('`/capture [width height [path]]` captures Rhino viewport as PNG.');
        console.log('`/model <model>` switches the active chat model for this session.');
        console.log('`/search <query>` runs grounded web lookup immediately.');
        console.log('`/web on|off` toggles search tool access.');
        console.log('`/ground on|off` toggles automatic grounding for unstable factual prompts.');
        console.log('`/memory on|off` toggles Obsidian recall/logging for this session.');
        console.log('`/models` browse and select available chat backends/models.');
        console.log('`/generate [prompt]` captures Rhino viewport → ComfyUI img2img with live progress.');
        console.log('`/clear` clears the in-memory conversation state.');
        console.log('Tab completes slash commands and `on|off` toggles.');
        continue;
      }
      if (raw === '/clear') {
        history.length = 0;
        console.log('Conversation cleared.');
        continue;
      }
      if (raw === '/status') {
        console.log(`backend ${resolveChatBackend(merged)} | model ${resolveChatModel(merged)}`);
        continue;
      }
      if (raw.startsWith('/model ')) {
        const value = raw.slice('/model '.length).trim();
        if (!value) {
          console.log('Usage: /model <model>');
          continue;
        }
        merged.baseModel = value;
        console.log(`model ${resolveChatModel(merged)}`);
        continue;
      }
      if (raw.startsWith('/web ')) {
        merged.allowSearch = raw.endsWith('on');
        console.log(`web ${merged.allowSearch ? 'on' : 'off'}`);
        continue;
      }
      if (raw.startsWith('/ground ')) {
        autoGround = raw.endsWith('on');
        console.log(`ground ${autoGround ? 'on' : 'off'}`);
        continue;
      }
      if (raw.startsWith('/memory ')) {
        useMemory = raw.endsWith('on');
        console.log(`memory ${useMemory ? 'on' : 'off'}`);
        continue;
      }
      if (raw === '/capture' || raw.startsWith('/capture ')) {
        const args = raw.slice('/capture'.length).trim().split(/\s+/);
        const w = Number(args[0]) || 1920;
        const h = Number(args[1]) || 1080;
        const out = args[2] || '/tmp/hii-rhino-capture.png';
        console.log(`Capturing Rhino viewport ${w}x${h} -> ${out}`);
        try {
          const { code, stdout, stderr } = await runShell(
            `python3 ~/hii/scripts/rhino_capture_viewport.py --width ${w} --height ${h} --output "${out}"`
          );
          console.log(code === 0 ? `\n${stdout}\n` : `\nCapture failed: ${stderr}\n`);
        } catch (e: any) {
          console.log(`\nCapture error: ${e?.message || e}\n`);
        }
        continue;
      }
      if (raw === '/models') {
        rl.close();
        const models = await listAllModels();
        const items = modelsToMenuItems(models);
        const pick = await interactiveMenu(items, {
          title: '  Select a model',
          pageSize: 15,
        });
        if (pick && pick.length > 0) {
          const [backend, ...rest] = pick[0].value.split(':');
          const validBackends = ['codex', 'mlx', 'ollama', 'claude'];
          merged.chatBackend = validBackends.includes(backend) ? backend as any : 'codex';
          merged.baseModel = rest.join(':') || backend;
          console.log(`backend ${resolveChatBackend(merged)} | model ${resolveChatModel(merged)}`);
        }
        // Re-create readline after raw-mode menu
        rl = readline.createInterface({ input, output, completer: completeChatLine });
        continue;
      }
      if (raw === '/tools') {
        rl.close();
        const toolItems = [
          // Macro tools
          { label: '/tool web_search', value: '/tool web_search', description: 'multi-provider web search' },
          { label: '/tool rag_search', value: '/tool rag_search', description: 'vector DB semantic search' },
          { label: '/tool shell', value: '/tool shell', description: 'execute shell commands' },
          { label: '/tool academic_search', value: '/tool academic_search', description: 'arxiv / openalex / crossref' },
          { label: '/tool rhino_capture', value: '/tool rhino_capture', description: 'capture Rhino 3D viewport' },
          // Micro tools (from registry)
          ...microTools.map((t) => ({
            label: `/tool ${t.name}`,
            value: `/tool ${t.name}`,
            description: t.description,
          })),
        ];
        const pick = await interactiveMenu(toolItems, { title: '  Tools', pageSize: 15 });
        rl = readline.createInterface({ input, output, completer: completeChatLine });
        if (pick && pick.length > 0) {
          console.log(`\n${pick[0].label}  ${pick[0].description ?? ''}\n`);
        }
        continue;
      }
      if (raw === '/generate' || raw.startsWith('/generate ')) {
        const genPrompt = raw.slice('/generate'.length).trim() || undefined;
        try {
          const { rhinoToComfy } = await import('./tools/rhino-to-comfy.js');
          const result = await rhinoToComfy({ prompt: genPrompt });
          console.log(`\nmodel: ${result.model}`);
          if (result.outputs.length) {
            console.log('outputs:');
            for (const o of result.outputs) console.log(`  ${o.url}`);
          }
          console.log();
        } catch (e: any) {
          console.log(`\nGeneration error: ${e?.message || e}\n`);
        }
        continue;
      }
      if (raw.startsWith('/search ')) {
        const query = raw.slice('/search '.length).trim();
        const result = merged.allowSearch && !merged.offline
          ? await webSearch(query, provider as any)
          : 'Search unavailable. Enable it with `--web` or `/web on`, and disable offline mode.';
        console.log(`\n${result}\n`);
        continue;
      }

      const turn = await withLoadingIndicator(
        `loading ${resolveChatBackend(merged)}:${resolveChatModel(merged)}`,
        async () => agentTurn(merged, raw, {
          interactive: true,
          webProvider: provider as any,
          scholarly: !!opts.scholarly,
          downloadPdfs: !!opts.downloadPdfs,
          useMemory,
          autoGround,
          history,
        }),
      );
      history.length = 0;
      history.push(...turn.messages.filter((message) => !message.content.startsWith('Recent memory context:\n')));
      appendConversationTurn({
        source: 'hii.chat',
        prompt: raw,
        answer: turn.text,
        tools: turn.usedTools,
      });
      console.log(`\n${turn.text}\n`);
    }
  } finally {
    rl.close();
  }
}

program.command('ingest')
  .description('Ingest files into local vector store')
  .option('-p, --path <path>', 'Path to ingest', 'workspace')
  .action(async (opts) => {
    const cfg = loadConfig();
    const root = path.resolve(process.cwd(), opts.path);
    if (!fs.existsSync(root)) {
      console.error(`Path not found: ${root}`);
      process.exit(1);
    }
    const db = new VectorStore(cfg.dbPath);
    console.log(`Ingesting ${root} -> ${cfg.dbPath}`);
    const count = await ingestPath(db, cfg.embedModel, root);
    console.log(`Ingested ${count} chunks.`);
  });

program.command('chat')
  .description('Codex-like chat interface for thought sharpening')
  .argument('[prompt...]', 'Prompt text')
  .option('--shell', 'Allow shell tool')
  .option('--web', 'Allow web search tool')
  .option('--web-provider <name>', 'Web provider: searxng|serpapi|duckduckgo', 'auto')
  .option('--scholarly', 'Use academic search (arXiv/OpenAlex/Crossref)')
  .option('--download-pdfs', 'Download open-access PDFs and ingest into RAG (with --scholarly)')
  .option('--no-memory', 'Disable memory recall and logging to Obsidian vault')
  .option('--memory-entries <n>', 'Max memory entries to recall', 'auto')
  .option('--online', 'Disable offline mode')
  .action(async (promptParts, opts) => {
    if (!promptParts?.length) {
      await runInteractiveChat(opts);
      return;
    }
    const cfg = loadConfig();
    const merged = { ...cfg, allowShell: !!opts.shell, allowSearch: !!opts.web, offline: !opts.online };
    const provider = opts.webProvider === 'auto' ? 'searxng' : opts.webProvider;
    if (opts.memoryEntries !== 'auto') merged.memoryMaxEntries = Number(opts.memoryEntries) || merged.memoryMaxEntries;
    const prompt = promptParts.join(' ');
    const text = await agentLoop(merged, prompt, {
      webProvider: provider as any,
      scholarly: !!opts.scholarly,
      downloadPdfs: !!opts.downloadPdfs,
      useMemory: !opts.noMemory,
      autoGround: true,
    });
    appendConversationTurn({
      source: 'hii.chat',
      prompt,
      answer: text,
      tools: [opts.shell ? 'shell' : '', opts.web ? 'web' : '', opts.scholarly ? 'scholarly' : ''].filter(Boolean),
    });
    console.log(text);
  });

program.command('browser')
  .description('Pass through to the locally installed agent-browser CLI')
  .addHelpText('after', '\nExamples:\n  hii browser install\n  hii browser open https://example.com\n  hii browser snapshot\n')
  .action(() => {
    console.error('Usage: hii browser <agent-browser args...>');
    process.exit(1);
  });

program.command('models')
  .description('Show or set active models')
  .option('--set-base <name>', 'Set base model')
  .option('--set-coder <name>', 'Set coder model')
  .option('--set-embed <name>', 'Set embed model')
  .option('--set-vault <path>', 'Set Obsidian vault path')
  .option('--set-memory <onoff>', 'Enable/disable memory (on|off)')
  .option('--set-memory-entries <n>', 'Set default memory recall entries')
  .action((opts) => {
    const cfg = loadConfig();
    if (opts.setBase || opts.setCoder || opts.setEmbed || opts.setVault || opts.setMemory || opts.setMemoryEntries) {
      const updates: any = {
        baseModel: opts.setBase ?? cfg.baseModel,
        coderModel: opts.setCoder ?? cfg.coderModel,
        embedModel: opts.setEmbed ?? cfg.embedModel,
      };
      if (opts.setVault) updates.obsidianVaultPath = opts.setVault;
      if (opts.setMemory) updates.memoryEnabled = String(opts.setMemory).toLowerCase() === 'on';
      if (opts.setMemoryEntries) updates.memoryMaxEntries = Number(opts.setMemoryEntries) || cfg.memoryMaxEntries;
      saveConfig(updates);
      console.log('Updated configuration.');
      if (updates.obsidianVaultPath) {
        import('./memory.js').then(({ checkVault }) => {
          const status = checkVault(updates.obsidianVaultPath);
          if (!status.exists) {
            console.warn('Warning: vault path does not exist:', updates.obsidianVaultPath);
            console.warn('Create this folder as an Obsidian vault or set a different path.');
          } else if (!status.hasObsidian) {
            console.warn('Warning: path exists but is not an Obsidian vault (.obsidian missing):', updates.obsidianVaultPath);
            console.warn('Open this folder in Obsidian to initialize the vault, or choose an existing vault path.');
          } else {
            console.log('Vault check: OK (.obsidian found).');
          }
        });
      }
    } else {
      console.log('Backend:', cfg.chatBackend);
      console.log('Base:', cfg.baseModel);
      console.log('Coder:', cfg.coderModel);
      console.log('Embed:', cfg.embedModel);
      if (cfg.obsidianVaultPath) console.log('Vault:', cfg.obsidianVaultPath);
      console.log('Memory enabled:', cfg.memoryEnabled);
      console.log('Memory entries:', cfg.memoryMaxEntries);
    }
  });

program.command('config')
  .description('Show config and paths')
  .action(() => {
    const cfg = loadConfig();
    console.log(JSON.stringify(cfg, null, 2));
  });

program.command('tool')
  .description('Tool builder utilities')
  .command('new')
  .argument('<name>', 'Tool name (file will be created)')
  .action(async (name) => {
    try {
      const { scaffoldTool } = await import('./tools/builder.js');
      const file = scaffoldTool(name);
      console.log(`Created tool: ${file}`);
      console.log('Run: npm run build to compile.');
    } catch (e: any) {
      console.error('Failed to create tool:', e?.message || e);
      process.exit(1);
    }
  });

program.command('updates')
  .description('Track updates and ideas')
  .command('add')
  .option('--title <text>', 'Title of the update/idea')
  .option('--body <text>', 'Body/notes')
  .option('--tags <csv>', 'Tags, comma-separated')
  .option('--to-vault', 'Also append to Obsidian vault under Updates/YYYY-MM.md')
  .action(async (opts) => {
    const title = opts.title || 'Untitled';
    const body = opts.body || '';
    const tags = typeof opts.tags === 'string' ? opts.tags.split(',').map((t: string)=>t.trim()).filter(Boolean) : [];
    const cfg = loadConfig();
    const { appendIdea, appendIdeaToVault } = await import('./logs.js');
    appendIdea(process.cwd(), title, body, tags);
    if (opts.toVault && cfg.obsidianVaultPath) appendIdeaToVault(cfg.obsidianVaultPath, title, body, tags);
    console.log('Logged update/idea:', title);
  });

program.command('release')
  .description('Manage releases and CHANGELOG')
  .command('bump')
  .option('--type <t>', 'major|minor|patch', 'patch')
  .option('--version <v>', 'Explicit version (overrides --type)')
  .option('--notes <text>', 'Release notes text')
  .action(async (opts) => {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const { bumpSemver, updateChangelog } = await import('./logs.js');
    const next = bumpSemver(pkg.version, opts.type, opts.version);
    pkg.version = next;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    const notes = opts.notes || '- Misc updates';
    updateChangelog(process.cwd(), next, notes);
    console.log(`Bumped version to ${next} and updated CHANGELOG.`);
  });

program.command('update')
  .description('Pull latest HII changes, rebuild, and re-seed skills')
  .option('--check', 'Only check for updates, do not apply')
  .action(async (opts) => {
    const hiiRoot = path.resolve(os.homedir(), 'hii');
    const exec = (cmd: string) => runShell(cmd, hiiRoot);

    // Fetch latest
    console.log('Fetching latest...');
    await exec('git fetch origin main');

    const { stdout: localRev } = await exec('git rev-parse HEAD');
    const { stdout: remoteRev } = await exec('git rev-parse origin/main');

    if (localRev.trim() === remoteRev.trim()) {
      console.log('HII is up to date.');
      return;
    }

    const { stdout: countStr } = await exec('git rev-list HEAD..origin/main --count');
    const count = parseInt(countStr.trim(), 10) || 0;
    console.log(`${count} update(s) available.`);

    if (opts.check) return;

    // Pull
    console.log('Pulling...');
    const pull = await exec('git pull origin main');
    if (pull.code !== 0) {
      console.error('Pull failed:', pull.stderr);
      process.exit(1);
    }

    // Rebuild
    console.log('Installing dependencies...');
    await exec('npm install');
    console.log('Building...');
    const build = await exec('npm run build');
    if (build.code !== 0) {
      console.error('Build failed:', build.stderr);
      process.exit(1);
    }

    // Re-seed skills
    console.log('Re-seeding skills...');
    await exec('python3 -m engine.cli skill seed');

    // Show new version
    const pkgPath = path.join(hiiRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      console.log(`Updated to v${pkg.version}`);
    }

    const { stdout: logStr } = await exec(`git log --oneline -${count}`);
    console.log('\nChanges:\n' + logStr.trim());
  });

const generations = program.command('generations').description('Track HII generations as named working-tree snapshots');

generations.command('paths')
  .description('Show generation storage paths')
  .action(() => {
    console.log(JSON.stringify(generationPaths(process.cwd()), null, 2));
  });

generations.command('snapshot')
  .description('Capture the current HII working tree as a named generation')
  .option('--id <id>', 'Generation id, e.g. g0')
  .option('--name <name>', 'Generation name')
  .option('--summary <text>', 'Why this generation matters')
  .option('--tags <csv>', 'Comma-separated tags')
  .option('--kind <kind>', 'snapshot|vision|release', 'snapshot')
  .option('--no-current', 'Do not mark this snapshot as the current generation')
  .action((opts) => {
    const tags = typeof opts.tags === 'string'
      ? opts.tags.split(',').map((tag: string) => tag.trim()).filter(Boolean)
      : [];
    const snapshot = createGenerationSnapshot(process.cwd(), {
      id: opts.id,
      name: opts.name,
      summary: opts.summary,
      tags,
      kind: opts.kind,
      markCurrent: opts.current,
    });
    console.log(JSON.stringify(snapshot, null, 2));
  });

generations.command('list')
  .description('List recorded HII generations')
  .action(() => {
    const records = listGenerations(process.cwd());
    const current = currentGeneration(process.cwd());
    console.log(formatGenerationSummary(records, current?.id));
  });

generations.command('current')
  .description('Show the current generation')
  .action(() => {
    const generation = currentGeneration(process.cwd());
    if (!generation) {
      console.log('No current generation recorded.');
      return;
    }
    console.log(formatGenerationDetail(generation));
  });

generations.command('show')
  .description('Show one recorded generation')
  .argument('<idOrName>', 'Generation id or name')
  .action((idOrName) => {
    const generation = getGeneration(process.cwd(), idOrName);
    if (!generation) {
      console.error(`Generation not found: ${idOrName}`);
      process.exit(1);
    }
    console.log(formatGenerationDetail(generation));
  });

const memory = program.command('memory').description('Memory utilities');

memory.command('test')
  .option('--vault <path>', 'Override vault path for test')
  .action(async (opts) => {
    const cfg = loadConfig();
    const vault = opts.vault || cfg.obsidianVaultPath;
    if (!vault) {
      console.error('No vault path configured. Use: hii models --set-vault <path>');
      process.exit(1);
    }
    const { appendChat, checkVault } = await import('./memory.js');
    const status = checkVault(vault);
    if (!status.exists) {
      console.error('Vault path does not exist:', vault);
      console.error('Create this folder as a vault in Obsidian (or set a different path).');
      process.exit(2);
    }
    if (!status.hasObsidian) {
      console.warn('Note: path exists but is not an Obsidian vault (.obsidian missing).');
      console.warn('Proceeding to write the chat log; add this folder as a vault in Obsidian to see files.');
    }
    const ts = new Date().toISOString();
    appendChat(vault, `Memory test at ${ts}`, 'OK: wrote to Obsidian vault');
    console.log('Wrote test entry to vault:', vault);
  });

memory.command('check')
  .option('--vault <path>', 'Override vault path for check')
  .action(async (opts) => {
    const cfg = loadConfig();
    const vault = opts.vault || cfg.obsidianVaultPath;
    if (!vault) {
      console.error('No vault path configured. Use: hii models --set-vault <path>');
      process.exit(1);
    }
    const { checkVault } = await import('./memory.js');
    const status = checkVault(vault);
    console.log('Vault path:', vault);
    console.log('Exists:', status.exists);
    console.log('Obsidian (.obsidian) present:', status.hasObsidian);
    if (!status.exists) {
      console.log('Action: Create this folder as an Obsidian vault or set a different path.');
    } else if (!status.hasObsidian) {
      console.log('Action: Open this folder in Obsidian to initialize it as a vault.');
    } else {
      console.log('Status: OK');
    }
  });

const duality = program.command('duality').description('Persistent Yin <-> Codex interaction layer');

duality.command('init')
  .description('Initialize Yin/Codex bridge state')
  .option('--yin-name <name>', 'Name for the reflective side', 'Yin')
  .option('--codex-name <name>', 'Name for the execution side', 'Yang')
  .action((opts) => {
    const state = initDuality(opts.yinName, opts.codexName);
    console.log(JSON.stringify(state, null, 2));
  });

duality.command('post')
  .description('Post a structured message between Yin and Codex')
  .requiredOption('--from <agent>', 'yin|codex')
  .requiredOption('--to <agent>', 'yin|codex|both')
  .requiredOption('--kind <kind>', 'context|plan|handoff|reflection|decision')
  .requiredOption('--topic <text>', 'Short topic for the message')
  .requiredOption('--message <text>', 'Message body')
  .option('--tags <csv>', 'Comma-separated tags')
  .action((opts) => {
    const tags = typeof opts.tags === 'string'
      ? opts.tags.split(',').map((tag: string) => tag.trim()).filter(Boolean)
      : [];
    const entry = postDualMessage({
      from: opts.from,
      to: opts.to,
      kind: opts.kind,
      topic: opts.topic,
      message: opts.message,
      tags,
    } as any);
    console.log(JSON.stringify(entry, null, 2));
  });

duality.command('read')
  .description('Read recent Yin/Yang messages')
  .option('--for <agent>', 'Filter for yin|yang')
  .option('--limit <n>', 'Number of messages to show', '20')
  .action((opts) => {
    const messages = readDualMessages({
      forAgent: opts.for,
      limit: Number(opts.limit) || 20,
    } as any);
    console.log(formatDualMessages(messages));
  });

const apps = program.command('apps').description('Track product apps and MVP readiness');

apps.command('add')
  .description('Register an app in the local product catalog')
  .requiredOption('--name <name>', 'App name')
  .option('--path <path>', 'Absolute or repo path')
  .option('--stack <csv>', 'Comma-separated stack')
  .option('--summary <text>', 'Short summary')
  .option('--status <status>', 'idea|building|mvp|paused|archived', 'idea')
  .option('--mvp-ready', 'Mark app as MVP-ready now')
  .option('--entry <path>', 'Primary entry file or route')
  .option('--tags <csv>', 'Comma-separated tags')
  .action((opts) => {
    const stack = typeof opts.stack === 'string' ? opts.stack.split(',').map((x: string) => x.trim()).filter(Boolean) : [];
    const tags = typeof opts.tags === 'string' ? opts.tags.split(',').map((x: string) => x.trim()).filter(Boolean) : [];
    const app = addApp({
      name: opts.name,
      path: opts.path,
      stack,
      summary: opts.summary,
      status: opts.status,
      mvpReady: !!opts.mvpReady,
      entry: opts.entry,
      tags,
    } as any);
    console.log(JSON.stringify(app, null, 2));
  });

apps.command('list')
  .description('List tracked apps')
  .action(() => {
    console.log(appsSummary());
  });

apps.command('show')
  .description('Show one tracked app')
  .argument('<name>', 'App name or slug')
  .action((name) => {
    const app = getApp(name);
    if (!app) {
      console.error(`App not found: ${name}`);
      process.exit(1);
    }
    console.log(JSON.stringify(app, null, 2));
  });

apps.command('set')
  .description('Update app status and MVP readiness')
  .argument('<name>', 'App name or slug')
  .option('--status <status>', 'idea|building|mvp|paused|archived')
  .option('--mvp-ready <value>', 'true|false')
  .option('--summary <text>', 'Updated summary')
  .option('--entry <path>', 'Primary entry file or route')
  .option('--stack <csv>', 'Comma-separated stack')
  .option('--tags <csv>', 'Comma-separated tags')
  .action((name, opts) => {
    const patch: any = {};
    if (opts.status) patch.status = opts.status;
    if (opts.mvpReady !== undefined) patch.mvpReady = String(opts.mvpReady).toLowerCase() === 'true';
    if (opts.summary !== undefined) patch.summary = opts.summary;
    if (opts.entry !== undefined) patch.entry = opts.entry;
    if (opts.stack) patch.stack = opts.stack.split(',').map((x: string) => x.trim()).filter(Boolean);
    if (opts.tags) patch.tags = opts.tags.split(',').map((x: string) => x.trim()).filter(Boolean);
    const app = updateApp(name, patch);
    console.log(JSON.stringify(app, null, 2));
  });

const conversations = program.command('conversations').description('Inspect persistent bridge conversation logs');

conversations.command('summary')
  .description('Show conversation ledger summary')
  .action(() => {
    console.log(JSON.stringify(conversationSummary(), null, 2));
  });

conversations.command('list')
  .description('List stored conversation transcript files')
  .action(() => {
    const paths = conversationPaths();
    const files = listConversationTranscripts();
    console.log(`Ledger: ${paths.ledger}`);
    console.log(`Transcripts: ${paths.transcripts}`);
    if (!files.length) {
      console.log('No transcript files found.');
      return;
    }
    for (const file of files) {
      console.log(file);
    }
  });

conversations.command('tail')
  .description('Show the most recent conversation entries')
  .option('-n, --limit <n>', 'Number of entries to show', '20')
  .action((opts) => {
    const limit = Number(opts.limit) || 20;
    const entries = readRecentConversationEntries(limit);
    console.log(formatConversationEntries(entries));
  });

conversations.command('show')
  .description('Show a saved transcript file')
  .argument('<file>', 'Transcript filename, e.g. 2026-03-28.md')
  .action((file) => {
    try {
      console.log(readConversationTranscript(file));
    } catch (error: any) {
      console.error(error?.message || String(error));
      process.exit(1);
    }
  });

const codex = program.command('codex').description('Persistent live document database for workspace knowledge');

codex.command('paths')
  .description('Show codex storage paths')
  .action(() => {
    console.log(JSON.stringify(codexPaths(), null, 2));
  });

codex.command('add')
  .description('Create or update a codex document')
  .requiredOption('--title <title>', 'Document title')
  .option('--kind <kind>', 'Document kind', 'note')
  .option('--summary <text>', 'Short summary')
  .option('--tags <csv>', 'Comma-separated tags')
  .option('--body <text>', 'Document body')
  .action((opts) => {
    const tags = typeof opts.tags === 'string'
      ? opts.tags.split(',').map((tag: string) => tag.trim()).filter(Boolean)
      : [];
    const doc = createCodexDoc({
      title: opts.title,
      kind: opts.kind,
      summary: opts.summary,
      tags,
      body: opts.body,
    });
    console.log(JSON.stringify(doc, null, 2));
  });

codex.command('workspace')
  .description('Create a bird\'s-eye codex entry for a workspace path')
  .option('--path <path>', 'Workspace root path', process.cwd())
  .option('--title <title>', 'Override document title')
  .action((opts) => {
    const doc = createWorkspaceCodex(opts.path, opts.title);
    console.log(JSON.stringify(doc, null, 2));
  });

codex.command('list')
  .description('List codex documents')
  .action(() => {
    const docs = listCodexDocs();
    if (!docs.length) {
      console.log('No codex documents found.');
      return;
    }
    for (const doc of docs) {
      console.log(`${doc.updatedAt}  ${doc.kind.padEnd(16)}  ${doc.slug}  ${doc.summary}`);
    }
  });

codex.command('show')
  .description('Show a codex document')
  .argument('<slugOrTitle>', 'Document slug or title')
  .action((slugOrTitle) => {
    const doc = getCodexDoc(slugOrTitle);
    if (!doc) {
      console.error(`Codex document not found: ${slugOrTitle}`);
      process.exit(1);
    }
    console.log(doc.body);
  });

codex.command('search')
  .description('Search codex documents by title, summary, kind, or tags')
  .argument('<query...>', 'Search query')
  .action((queryParts) => {
    const results = searchCodexDocs(queryParts.join(' '));
    if (!results.length) {
      console.log('No codex documents matched.');
      return;
    }
    for (const doc of results) {
      console.log(`${doc.updatedAt}  ${doc.kind.padEnd(16)}  ${doc.slug}  ${doc.summary}`);
    }
  });

program.command('papers')
  .description('Fetch and ingest open-access PDFs for a scholarly query')
  .argument('<query...>', 'Academic query')
  .option('--max <n>', 'Max papers to fetch', '3')
  .action(async (qParts, opts) => {
    const query = qParts.join(' ');
    const cfg = loadConfig();
    const items = await (await import('./tools/academic.js')).academicSearch(query, Number(opts.max) || 3);
    const oa = items.map(it => ({ title: it.title, url: it.url })).filter(x => x.url && /\.pdf($|\?)/i.test(x.url)).slice(0, Number(opts.max) || 3);
    const db = new (await import('./store/vectordb.js')).VectorStore(cfg.dbPath);
    let total = 0;
    for (const r of oa) {
      try {
        const p = await (await import('./tools/papers.js')).downloadPdf(r.url, r.title);
        const n = await (await import('./tools/papers.js')).ingestPdfToRag(db, cfg.embedModel, p);
        total += n;
        console.log(`Fetched ${r.title} -> ${p} (${n} chunks)`);
      } catch (e: any) {
        console.error(`Failed ${r.title}: ${e?.message || e}`);
      }
    }
    console.log(`Total chunks ingested: ${total}`);
  });

const notes = program.command('notes').description('Note-taking helpers');

notes.command('audio')
  .description('Transcribe audio via LM Studio and summarize to Markdown')
  .requiredOption('-f, --file <path>', 'Audio file to process')
  .option('-t, --title <text>', 'Title for the generated note')
  .option('-o, --out-dir <path>', 'Directory to write the Markdown note')
  .option('--chat-model <name>', 'LM Studio chat model for summarization')
  .option('--transcribe-model <name>', 'LM Studio model for transcription')
  .option('--lm-url <url>', 'LM Studio base URL (OpenAI-compatible)')
  .option('--lm-api-key <key>', 'LM Studio API key if required')
  .option('--keep-transcript', 'Also save the raw transcript')
  .action(async (opts) => {
    const cfg = loadConfig();
    const { createAudioNote } = await import('./tools/notetaker.js');
    const res = await createAudioNote(cfg, opts.file, {
      title: opts.title,
      outputDir: opts.outDir,
      chatModel: opts.chatModel,
      transcribeModel: opts.transcribeModel,
      baseUrl: opts.lmUrl,
      apiKey: opts.lmApiKey,
      keepTranscript: !!opts.keepTranscript
    });
    console.log('Note saved to:', res.notePath);
    if (res.transcriptPath) console.log('Transcript saved to:', res.transcriptPath);
  });

const space = program.command('space').description('Desktop and window-manager integration');

space.command('health')
  .description('Report the desktop backend status')
  .action(async () => {
    console.log(JSON.stringify(await getSpaceHealth(), null, 2));
  });

space.command('snapshot')
  .description('Return monitors, workspaces, and windows from the active desktop backend')
  .action(async () => {
    console.log(JSON.stringify(await getSpaceSnapshot(), null, 2));
  });

space.command('focus-window')
  .description('Focus a specific window by backend window id')
  .requiredOption('--id <windowId>', 'Backend window id')
  .action(async (opts) => {
    console.log(JSON.stringify(await focusSpaceWindow(String(opts.id)), null, 2));
  });

space.command('switch-workspace')
  .description('Switch to a workspace by name')
  .requiredOption('--name <workspace>', 'Workspace name')
  .action(async (opts) => {
    console.log(JSON.stringify(await switchSpaceWorkspace(String(opts.name)), null, 2));
  });

space.command('apps')
  .description('List running applications visible to AeroSpace')
  .action(async () => {
    console.log(JSON.stringify(await listSpaceApps(), null, 2));
  });

space.command('focus-monitor')
  .description('Focus a monitor by pattern, order, or relative direction')
  .requiredOption('--target <target>', 'Examples: next, prev, 1, 2, main')
  .action(async (opts) => {
    console.log(JSON.stringify(await focusSpaceMonitor(String(opts.target)), null, 2));
  });

space.command('move-window-to-workspace')
  .description('Move the focused window to a workspace')
  .requiredOption('--name <workspace>', 'Workspace name')
  .action(async (opts) => {
    console.log(JSON.stringify(await moveSpaceWindowToWorkspace(String(opts.name)), null, 2));
  });

space.command('move-workspace-to-monitor')
  .description('Move the focused workspace to a monitor')
  .requiredOption('--target <target>', 'Examples: next, prev, 1, 2, main')
  .action(async (opts) => {
    console.log(JSON.stringify(await moveSpaceWorkspaceToMonitor(String(opts.target)), null, 2));
  });

space.command('reload-config')
  .description('Reload the active AeroSpace config')
  .action(async () => {
    console.log(JSON.stringify(await reloadSpaceConfig(), null, 2));
  });

space.command('balance')
  .description('Balance window sizes on the focused workspace')
  .action(async () => {
    console.log(JSON.stringify(await balanceSpaceSizes(), null, 2));
  });

const remote = program.command('remote').description('Browser-launchable remote machines and sessions');
const remoteWindows = remote.command('windows').description('Manage Windows browser remote targets over Tailscale');
const remoteSsh = remote.command('ssh').description('Manage SSH remotes over Tailscale');

remoteWindows.command('add')
  .description('Register a Windows machine reachable through a browser endpoint')
  .requiredOption('--name <name>', 'Display name for this machine')
  .option('--provider <provider>', 'novnc|guacamole|custom', 'novnc')
  .option('--host <host>', 'Tailscale hostname or IP, e.g. mypc.tailnet.ts.net')
  .option('--port <n>', 'Remote web port. Default noVNC is usually 6080')
  .option('--scheme <scheme>', 'http|https', 'http')
  .option('--path <path>', 'Override remote path. noVNC default is /vnc.html?autoconnect=1&resize=remote&reconnect=1&view_only=0')
  .option('--url <url>', 'Exact custom URL for provider=custom')
  .option('--notes <text>', 'Optional notes')
  .action((opts) => {
    const remote = addRemote({
      name: opts.name,
      provider: opts.provider,
      host: opts.host,
      port: opts.port ? Number(opts.port) : undefined,
      scheme: opts.scheme,
      path: opts.path,
      url: opts.url,
      notes: opts.notes,
    } as any);
    console.log(JSON.stringify({ ...remote, resolvedUrl: buildRemoteUrl(remote) }, null, 2));
  });

remoteWindows.command('list')
  .description('List configured Windows browser remotes')
  .action(() => {
    console.log(remoteSummary());
  });

remoteWindows.command('show')
  .description('Show one configured remote')
  .argument('<name>', 'Remote name or slug')
  .action((name) => {
    const remote = getRemote(name);
    if (!remote) {
      console.error(`remote not found: ${name}`);
      process.exit(1);
    }
    console.log(JSON.stringify({ ...remote, resolvedUrl: buildRemoteUrl(remote) }, null, 2));
  });

remoteWindows.command('url')
  .description('Print the resolved browser URL for a remote')
  .argument('<name>', 'Remote name or slug')
  .action((name) => {
    const remote = getRemote(name);
    if (!remote) {
      console.error(`remote not found: ${name}`);
      process.exit(1);
    }
    console.log(buildRemoteUrl(remote));
  });

remoteWindows.command('open')
  .description('Open the browser remote for a Windows machine')
  .argument('<name>', 'Remote name or slug')
  .action(async (name) => {
    const result = await openRemote(name);
    console.log(JSON.stringify(result, null, 2));
  });

remoteWindows.command('session')
  .description('Open a Windows remote inside the HII browser session surface')
  .argument('<name>', 'Remote name or slug')
  .option('--port <n>', 'Local HII server port', '8787')
  .action(async (name, opts) => {
    const remote = getRemote(name);
    if (!remote) {
      console.error(`remote not found: ${name}`);
      process.exit(1);
    }
    const url = `http://127.0.0.1:${Number(opts.port) || 8787}/remote.html?remote=${encodeURIComponent(remote.slug)}`;
    const { execFile } = await import('node:child_process');
    execFile('open', [url], (error) => {
      if (error) {
        console.error(String(error));
        process.exit(1);
      }
      console.log(url);
    });
  });

remoteSsh.command('add')
  .description('Register an SSH host reachable over Tailscale')
  .requiredOption('--name <name>', 'Display name for this machine')
  .requiredOption('--host <host>', 'Tailscale hostname or IP')
  .option('--user <user>', 'SSH username')
  .option('--port <n>', 'SSH port', '22')
  .option('--auth <auth>', 'agent|password|key', 'agent')
  .option('--key <path>', 'Private key path when using key auth')
  .option('--notes <text>', 'Optional notes')
  .action((opts) => {
    const remote = addSshRemote({
      name: opts.name,
      host: opts.host,
      user: opts.user,
      port: opts.port ? Number(opts.port) : undefined,
      auth: opts.auth,
      keyPath: opts.key,
      notes: opts.notes,
    } as any);
    console.log(JSON.stringify(remote, null, 2));
  });

remoteSsh.command('list')
  .description('List configured SSH remotes')
  .action(() => {
    console.log(sshRemoteSummary());
  });

remoteSsh.command('show')
  .description('Show one configured SSH remote')
  .argument('<name>', 'Remote name or slug')
  .action((name) => {
    const remote = getSshRemote(name);
    if (!remote) {
      console.error(`ssh remote not found: ${name}`);
      process.exit(1);
    }
    console.log(JSON.stringify(remote, null, 2));
  });

remoteSsh.command('test')
  .description('Test SSH connectivity to a remote')
  .argument('<name>', 'Remote name or slug')
  .action(async (name) => {
    const result = await testSshRemote(name);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
  });

remoteSsh.command('exec')
  .description('Execute a command on an SSH remote')
  .argument('<name>', 'Remote name or slug')
  .requiredOption('--cmd <command>', 'Remote command to run')
  .action(async (name, opts) => {
    const result = await execSshRemote(name, String(opts.cmd));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(result.code || 1);
  });

// Serve command (define before parse)
program.command('serve')
  .description('Start local HTTP server for hii APIs')
  .option('-p, --port <n>', 'Port to listen on', '8787')
  .option('--shell', 'Allow shell tool by default')
  .option('--web', 'Allow web search by default')
  .option('--web-provider <name>', 'Web provider: serpapi|duckduckgo', 'auto')
  .option('--scholarly', 'Enable scholarly tool by default')
  .option('--download-pdfs', 'Enable OA PDF download in scholarly mode by default')
  .option('--no-memory', 'Disable memory by default')
  .action(async (opts) => {
    const provider = opts.webProvider === 'auto' ? undefined : opts.webProvider;
    const { startServer } = await import('./server.js');
    const srv = await startServer({
      port: Number(opts.port) || 8787,
      allowShell: !!opts.shell,
      allowSearch: !!opts.web,
      webProvider: provider,
      scholarly: !!opts.scholarly,
      downloadPdfs: !!opts.downloadPdfs,
      memory: !opts.noMemory,
    });
    console.log(`hii server listening on http://127.0.0.1:${srv.port}`);
  });


// ── comfyui ──────────────────────────────────────────────────────────────────
const comfyui = program.command('comfyui').description('Manage ComfyUI + MCP server');

comfyui.command('start')
  .description('Spawn the ComfyUI MCP server in the background')
  .option('--no-mcp', 'Skip MCP server (only ping remote ComfyUI)')
  .action(async (opts) => {
    const { comfyuiStart } = await import('./tools/comfyui.js');
    await comfyuiStart({ noMcp: !opts.mcp });
  });

comfyui.command('stop')
  .description('Stop the ComfyUI MCP server')
  .action(async () => {
    const { comfyuiStop } = await import('./tools/comfyui.js');
    comfyuiStop();
  });

comfyui.command('status')
  .description('Show ComfyUI + MCP server status')
  .action(async () => {
    const { comfyuiStatus } = await import('./tools/comfyui.js');
    await comfyuiStatus();
  });

comfyui.command('logs')
  .description('Tail ComfyUI or MCP server logs')
  .option('-n, --lines <n>', 'Lines to show', '80')
  .option('--mcp', 'Show MCP server logs instead of ComfyUI')
  .action(async (opts) => {
    const { comfyuiLogs } = await import('./tools/comfyui.js');
    comfyuiLogs(Number(opts.lines) || 80, opts.mcp ? 'mcp' : 'comfyui');
  });

comfyui.command('models')
  .description('List checkpoint models available in ComfyUI')
  .action(async () => {
    const { comfyuiModels } = await import('./tools/comfyui.js');
    await comfyuiModels();
  });

comfyui.command('config')
  .description('Show the ComfyUI model-path configuration HII expects on this Mac')
  .action(async () => {
    const { comfyuiPrintModelConfig } = await import('./tools/comfyui.js');
    comfyuiPrintModelConfig();
  });

comfyui.command('plan')
  .description('Plan a natural-language ComfyUI request into a structured invocation')
  .argument('<request...>', 'Natural-language creation request')
  .option('--model <name>', 'Checkpoint model name')
  .option('--negative <text>', 'Negative prompt override')
  .option('--width <n>', 'Target width')
  .option('--height <n>', 'Target height')
  .option('--steps <n>', 'Sampling steps')
  .option('--cfg <n>', 'CFG scale')
  .option('--seed <n>', 'Seed')
  .option('--batch-size <n>', 'Batch size', '1')
  .option('--output-prefix <text>', 'SaveImage filename prefix')
  .option('--json', 'Print plan as JSON')
  .action(async (requestParts, opts) => {
    const { comfyuiPlanCommand } = await import('./tools/comfyui-create.js');
    await comfyuiPlanCommand(requestParts.join(' '), {
      model: opts.model,
      negative: opts.negative,
      width: opts.width ? Number(opts.width) : undefined,
      height: opts.height ? Number(opts.height) : undefined,
      steps: opts.steps ? Number(opts.steps) : undefined,
      cfg: opts.cfg ? Number(opts.cfg) : undefined,
      seed: opts.seed ? Number(opts.seed) : undefined,
      batchSize: Number(opts.batchSize) || 1,
      outputPrefix: opts.outputPrefix,
      json: !!opts.json,
    });
  });

comfyui.command('create')
  .description('Submit a natural-language image request to ComfyUI')
  .argument('<request...>', 'Natural-language creation request')
  .option('--model <name>', 'Checkpoint model name')
  .option('--negative <text>', 'Negative prompt override')
  .option('--width <n>', 'Target width')
  .option('--height <n>', 'Target height')
  .option('--steps <n>', 'Sampling steps')
  .option('--cfg <n>', 'CFG scale')
  .option('--seed <n>', 'Seed')
  .option('--batch-size <n>', 'Batch size', '1')
  .option('--output-prefix <text>', 'SaveImage filename prefix')
  .option('--wait', 'Wait for ComfyUI outputs and print view URLs')
  .option('--dry-run', 'Only plan and log the request without submitting')
  .option('--json', 'Print result as JSON')
  .action(async (requestParts, opts) => {
    const { comfyuiCreate } = await import('./tools/comfyui-create.js');
    await comfyuiCreate(requestParts.join(' '), {
      model: opts.model,
      negative: opts.negative,
      width: opts.width ? Number(opts.width) : undefined,
      height: opts.height ? Number(opts.height) : undefined,
      steps: opts.steps ? Number(opts.steps) : undefined,
      cfg: opts.cfg ? Number(opts.cfg) : undefined,
      seed: opts.seed ? Number(opts.seed) : undefined,
      batchSize: Number(opts.batchSize) || 1,
      outputPrefix: opts.outputPrefix,
      wait: !!opts.wait,
      dryRun: !!opts.dryRun,
      json: !!opts.json,
    });
  });

comfyui.command('requests')
  .description('Show recent ComfyUI create requests logged by HII')
  .option('-n, --limit <n>', 'Number of entries to show', '20')
  .option('--json', 'Print request log as JSON')
  .action(async (opts) => {
    const { comfyuiRequests } = await import('./tools/comfyui-create.js');
    comfyuiRequests(Number(opts.limit) || 20, !!opts.json);
  });

// default: `hii comfyui` alone → start
comfyui.action(async () => {
  const { comfyuiStart } = await import('./tools/comfyui.js');
  await comfyuiStart();
});

const rhino = program.command('rhino').description('Rhino integration and command installation');

rhino.command('install-hii')
  .description('Install the HII launcher as a Rhino alias in the active Rhino session')
  .option('--alias <name>', 'Rhino alias name', 'Hii')
  .option('--server <command>', 'RhinoMCP server command', 'uvx rhinomcp')
  .option('--timeout <seconds>', 'Timeout seconds', '30')
  .action(async (opts) => {
    const { runShell } = await import('./tools/shell.js');
    const alias = String(opts.alias || 'Hii');
    const server = String(opts.server || 'uvx rhinomcp');
    const timeout = Number(opts.timeout) || 30;
    const cmd = [
      'python3',
      'scripts/rhino_install_hii_command.py',
      '--alias',
      JSON.stringify(alias),
      '--server',
      JSON.stringify(server),
      '--timeout',
      String(timeout),
    ].join(' ');
    const { code, stdout, stderr } = await runShell(cmd);
    if (code !== 0) {
      console.error(stderr || stdout || 'Rhino HII install failed.');
      process.exit(1);
    }
    console.log(stdout);
  });

const threeD = program.command('3d').description('Direct 3D runtimes and image-to-mesh workflows');

threeD.command('install')
  .description('Install direct 3D runtimes without ComfyUI')
  .option('--target <name>', 'triposr|hunyuan|all', 'all')
  .option('--skip-clone', 'Skip cloning repos')
  .action(async (opts) => {
    const { runShell } = await import('./tools/shell.js');
    const target = String(opts.target || 'all');
    const cmd = [
      'python3',
      'scripts/install_direct_3d_models.py',
      '--target',
      target,
      opts.skipClone ? '--skip-clone' : '',
    ].filter(Boolean).join(' ');
    const { code, stdout, stderr } = await runShell(cmd);
    if (code !== 0) {
      console.error(stderr || stdout || '3D runtime install failed.');
      process.exit(1);
    }
    console.log(stdout);
  });

threeD.command('triposr')
  .description('Run direct TripoSR image-to-mesh inference')
  .argument('<image>', 'Input image path')
  .option('--output-dir <dir>', 'Output directory', '/tmp/hii-triposr-output')
  .option('--model <pathOrId>', 'HF model id or local model path', 'stabilityai/TripoSR')
  .option('--device <name>', 'mps|cuda:0|cpu')
  .option('--format <name>', 'glb|obj', 'glb')
  .option('--no-remove-bg', 'Skip background removal')
  .action(async (image, opts) => {
    const { runShell } = await import('./tools/shell.js');
    const cmd = [
      'python3',
      'scripts/triposr_infer.py',
      JSON.stringify(String(image)),
      '--output-dir',
      JSON.stringify(String(opts.outputDir || '/tmp/hii-triposr-output')),
      '--model',
      JSON.stringify(String(opts.model || 'stabilityai/TripoSR')),
      '--format',
      String(opts.format || 'glb'),
      opts.device ? ['--device', JSON.stringify(String(opts.device))].join(' ') : '',
      opts.noRemoveBg ? '--no-remove-bg' : '',
    ].filter(Boolean).join(' ');
    const { code, stdout, stderr } = await runShell(cmd);
    if (code !== 0) {
      console.error(stderr || stdout || 'TripoSR inference failed.');
      process.exit(1);
    }
    console.log(stdout);
  });

async function main() {
  const handled = await maybeHandleBrowserPassthrough();
  if (handled) return;
  const argv = normalizeCliArgv(program, process.argv);
  await program.parseAsync(argv);
}

main().catch((error: any) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
