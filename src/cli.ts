#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, saveConfig } from './config.js';
import { VectorStore } from './store/vectordb.js';
import { ingestPath } from './rag/ingest.js';
import { agentLoop } from './agent.js';
import { addApp, appsSummary, getApp, listApps, updateApp } from './apps.js';
import { formatDualMessages, initDuality, postDualMessage, readDualMessages } from './duality.js';
import { runAgentBrowser } from './tools/browser.js';
import { focusSpaceWindow, getSpaceHealth, getSpaceSnapshot, switchSpaceWorkspace } from './tools/space.js';

const program = new Command();
program.name('hii').description('Local agentic CLI powered by Ollama').version('0.1.0');

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
  .description('Interactive single-prompt chat with tools')
  .argument('<prompt...>', 'Prompt text')
  .option('--shell', 'Allow shell tool')
  .option('--web', 'Allow web search tool')
  .option('--web-provider <name>', 'Web provider: serpapi|duckduckgo', 'auto')
  .option('--scholarly', 'Use academic search (arXiv/OpenAlex/Crossref)')
  .option('--download-pdfs', 'Download open-access PDFs and ingest into RAG (with --scholarly)')
  .option('--no-memory', 'Disable memory recall and logging to Obsidian vault')
  .option('--memory-entries <n>', 'Max memory entries to recall', 'auto')
  .option('--online', 'Disable offline mode')
  .action(async (promptParts, opts) => {
    const cfg = loadConfig();
    const merged = { ...cfg, allowShell: !!opts.shell, allowSearch: !!opts.web, offline: !opts.online };
    const provider = opts.webProvider === 'auto' ? undefined : opts.webProvider;
    if (opts.memoryEntries !== 'auto') merged.memoryMaxEntries = Number(opts.memoryEntries) || merged.memoryMaxEntries;
    const text = await agentLoop(merged, promptParts.join(' '), { webProvider: provider as any, scholarly: !!opts.scholarly, downloadPdfs: !!opts.downloadPdfs, useMemory: !opts.noMemory });
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

// default: `hii comfyui` alone → start
comfyui.action(async () => {
  const { comfyuiStart } = await import('./tools/comfyui.js');
  await comfyuiStart();
});

async function main() {
  const handled = await maybeHandleBrowserPassthrough();
  if (handled) return;
  await program.parseAsync(process.argv);
}

main().catch((error: any) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
