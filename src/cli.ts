#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, saveConfig } from './config.js';
import { VectorStore } from './store/vectordb.js';
import { ingestPath } from './rag/ingest.js';
import { agentLoop } from './agent.js';

const program = new Command();
program.name('hii').description('Local agentic CLI powered by Ollama').version('0.1.0');

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

program.command('memory')
  .description('Memory utilities')
  .command('test')
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

program.command('memory')
  .description('Memory utilities')
  .command('check')
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

program.parseAsync(process.argv);
