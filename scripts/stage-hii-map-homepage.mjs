#!/usr/bin/env node
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BACKUP = path.join(os.tmpdir(), 'hii-map-homepage-original-index.html');

function isHiiMapIndex(html) {
  return /<title\b[^>]*>[^<]*\bHII\s+Map\b[^<]*<\/title>/i.test(html);
}

function requireDirectory(directory, label) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new Error(`${label} directory is missing: ${directory}`);
  }
}

export function stageHiiMapHomepage({ distDirectory, outputDirectory = path.join(repositoryRoot, 'out'), backupPath = DEFAULT_BACKUP }) {
  if (!distDirectory) throw new Error('Usage: node scripts/stage-hii-map-homepage.mjs <vite-dist-directory>');
  const dist = path.resolve(distDirectory);
  const output = path.resolve(outputDirectory);
  const backup = path.resolve(backupPath);
  if (dist === output || output.startsWith(`${dist}${path.sep}`) || dist.startsWith(`${output}${path.sep}`)) {
    throw new Error('Vite dist and static output directories must be separate, non-nested paths');
  }

  const indexPath = path.join(dist, 'index.html');
  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) throw new Error(`Vite index is missing: ${indexPath}`);
  const index = readFileSync(indexPath);
  if (!isHiiMapIndex(index.toString('utf8'))) throw new Error('Vite index title must identify the page as HII Map');
  requireDirectory(path.join(dist, 'assets'), 'Vite assets');
  requireDirectory(path.join(dist, 'cesium'), 'Cesium runtime assets');

  mkdirSync(output, { recursive: true });
  const currentIndexPath = path.join(output, 'index.html');
  let previousHomepage = null;
  if (existsSync(currentIndexPath)) {
    const currentIndex = readFileSync(currentIndexPath);
    if (!isHiiMapIndex(currentIndex.toString('utf8'))) {
      mkdirSync(path.dirname(backup), { recursive: true });
      if (existsSync(backup)) {
        if (!readFileSync(backup).equals(currentIndex)) {
          throw new Error(`Homepage backup already exists with different contents: ${backup}`);
        }
      }
      previousHomepage = currentIndex;
    }
  }

  // Install runtime files first so the old root page remains usable until the
  // complete new page's files are present.
  cpSync(path.join(dist, 'assets'), path.join(output, 'assets'), { recursive: true, force: true });
  cpSync(path.join(dist, 'cesium'), path.join(output, 'cesium'), { recursive: true, force: true });
  if (existsSync(path.join(dist, 'logo.svg'))) copyFileSync(path.join(dist, 'logo.svg'), path.join(output, 'logo.svg'));
  if (existsSync(path.join(dist, 'hii-map-notices.txt'))) copyFileSync(path.join(dist, 'hii-map-notices.txt'), path.join(output, 'hii-map-notices.txt'));
  if (previousHomepage) {
    const workspacePage = path.join(output, 'workspace.html');
    if (!existsSync(workspacePage)) copyFileSync(currentIndexPath, workspacePage);
    if (!existsSync(backup)) copyFileSync(currentIndexPath, backup);
  }
  copyFileSync(indexPath, currentIndexPath);
  return { index: currentIndexPath, assets: path.join(output, 'assets'), cesium: path.join(output, 'cesium'), backup: existsSync(backup) ? backup : null };
}

function main(args) {
  if (args.length !== 1) throw new Error('Usage: node scripts/stage-hii-map-homepage.mjs <vite-dist-directory>');
  const result = stageHiiMapHomepage({ distDirectory: args[0] });
  process.stdout.write(`Staged HII Map homepage: ${result.index}\n`);
  if (result.backup) process.stdout.write(`Preserved previous homepage: ${result.backup}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
