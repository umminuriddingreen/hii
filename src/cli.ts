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
  .action((opts) => {
    const cfg = loadConfig();
    if (opts.setBase || opts.setCoder || opts.setEmbed) {
      saveConfig({
        baseModel: opts.setBase ?? cfg.baseModel,
        coderModel: opts.setCoder ?? cfg.coderModel,
        embedModel: opts.setEmbed ?? cfg.embedModel,
      });
      console.log('Updated models.');
    } else {
      console.log('Base:', cfg.baseModel);
      console.log('Coder:', cfg.coderModel);
      console.log('Embed:', cfg.embedModel);
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

program.parseAsync(process.argv);
