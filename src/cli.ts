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
  .option('--online', 'Disable offline mode')
  .action(async (promptParts, opts) => {
    const cfg = loadConfig();
    const merged = { ...cfg, allowShell: !!opts.shell, allowSearch: !!opts.web, offline: !opts.online };
    const text = await agentLoop(merged, promptParts.join(' '));
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

program.parseAsync(process.argv);
