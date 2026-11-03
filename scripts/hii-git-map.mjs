#!/usr/bin/env node
// A terminal-native, read-only spatial view of repository history.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIELD = '\x1f';
const RECORD = '\x1e';

function git(repo, args, options = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options
  });
}

export function resolveRepository(candidate = process.cwd()) {
  return git(path.resolve(candidate), ['rev-parse', '--show-toplevel']).trim();
}

export function readCommitMap(repo, limit = 30) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 200));
  const format = `${RECORD}%H${FIELD}%h${FIELD}%aI${FIELD}%an${FIELD}%s${FIELD}%D`;
  const output = git(repo, [
    'log', '--all', '--graph', '--topo-order', `--max-count=${safeLimit}`,
    `--pretty=format:${format}`
  ]);

  const commits = [];
  for (const line of output.split(/\r?\n/)) {
    const marker = line.indexOf(RECORD);
    if (marker < 0) continue;
    const graph = line.slice(0, marker).replace(/\s+$/, '');
    const [hash, shortHash, authoredAt, author, subject, refs = ''] = line.slice(marker + 1).split(FIELD);
    commits.push({ index: commits.length + 1, graph, hash, shortHash, authoredAt, author, subject, refs });
  }
  return commits;
}

function compactDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace('T', ' ').slice(0, 16);
}

export function renderCommitMap(commits, repo) {
  const graphWidth = Math.max(1, ...commits.map((commit) => commit.graph.length));
  const spatialWidth = Math.max(graphWidth, 'space/topology'.length);
  const lines = [
    `HII GIT MAP  ${repo}`,
    'space/topology'.padEnd(spatialWidth + 6) + 'time (UTC)        commit   change',
    '-'.repeat(Math.min(120, spatialWidth + 94))
  ];
  for (const commit of commits) {
    const node = commit.graph || '*';
    const refs = commit.refs ? `  [${commit.refs}]` : '';
    lines.push(
      `${node.padEnd(spatialWidth)}  ${String(commit.index).padStart(3)}  ${compactDate(commit.authoredAt)}  ${commit.shortHash}  ${commit.subject}${refs}`
    );
  }
  lines.push('', 'Select a diff: hii git-map diff <number|commit>   Full patch: add --patch');
  return lines.join('\n');
}

export function resolveSelection(commits, selection) {
  const index = Number(selection);
  if (Number.isInteger(index) && index >= 1 && index <= commits.length) return commits[index - 1].hash;
  const direct = commits.find((commit) => commit.hash === selection || commit.shortHash === selection);
  return direct?.hash ?? selection;
}

export function renderDiff(repo, revision, patch = false) {
  const verified = git(repo, ['rev-parse', '--verify', `${revision}^{commit}`]).trim();
  const header = git(repo, ['show', '-s', '--date=iso-strict', '--format=%H%n%aI%n%an <%ae>%n%s%n%D', verified]).trim();
  const args = patch
    ? ['show', '--format=', '--find-renames', '--find-copies', verified]
    : ['show', '--format=', '--stat', '--summary', '--find-renames', '--find-copies', verified];
  return `HII COMMIT DIFF\n${header}\n\n${git(repo, args).trimEnd()}`;
}

function option(args, name, fallback) {
  const equals = args.find((arg) => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

export function cmdGitMap(args, io = console) {
  const repo = resolveRepository(option(args, '--repo', process.cwd()));
  const limit = option(args, '--limit', '30');
  const commits = readCommitMap(repo, limit);
  const action = args.find((arg) => !arg.startsWith('-') && arg !== option(args, '--repo') && arg !== option(args, '--limit'));

  if (action === 'diff' || action === 'show') {
    const position = args.indexOf(action);
    const selection = args[position + 1];
    if (!selection || selection.startsWith('-')) throw new Error('usage: hii git-map diff <number|commit> [--patch] [--limit N]');
    io.log(renderDiff(repo, resolveSelection(commits, selection), args.includes('--patch')));
    return;
  }
  if (args.includes('--json')) {
    io.log(JSON.stringify({ repository: repo, generatedAt: new Date().toISOString(), commits }, null, 2));
    return;
  }
  io.log(renderCommitMap(commits, repo));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    cmdGitMap(process.argv.slice(2));
  } catch (error) {
    console.error(`hii git-map: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
