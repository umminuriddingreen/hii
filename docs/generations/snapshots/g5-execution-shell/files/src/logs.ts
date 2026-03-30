import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

export function appendIdea(repoRoot: string, title: string, body?: string, tags?: string[]) {
  const logDir = path.resolve(repoRoot, 'docs');
  ensureDir(logDir);
  const file = path.join(logDir, 'updates.md');
  const ts = new Date().toISOString();
  const tagStr = tags && tags.length ? ` [${tags.map(t=>`#${t}`).join(' ')}]` : '';
  const entry = `\n### ${title}${tagStr}\n- date: ${ts}\n\n${body || ''}\n`;
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# Updates & Ideas\n\nThis log tracks ideas, plans, and release notes in progress.\n\n${entry}`);
  } else {
    fs.appendFileSync(file, entry);
  }
}

export function appendIdeaToVault(vaultPath: string, title: string, body?: string, tags?: string[]) {
  const dir = path.join(vaultPath, 'Updates');
  ensureDir(dir);
  const ym = new Date().toISOString().slice(0,7); // YYYY-MM
  const file = path.join(dir, `${ym}.md`);
  const ts = new Date().toISOString();
  const tagStr = tags && tags.length ? ` [${tags.map(t=>`#${t}`).join(' ')}]` : '';
  const entry = `\n## ${title}${tagStr}\n- date: ${ts}\n\n${body || ''}\n`;
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `---\ncreated: ${ts}\n---\n\n# Updates ${ym}\n${entry}`);
  } else {
    fs.appendFileSync(file, entry);
  }
}

export function bumpSemver(current: string, type: 'major'|'minor'|'patch', setVersion?: string): string {
  if (setVersion) return setVersion;
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)(.*)?$/);
  if (!m) return current;
  let [_, MA, MI, PA, rest] = m;
  let major = parseInt(MA,10), minor=parseInt(MI,10), patch=parseInt(PA,10);
  if (type==='major') { major++; minor=0; patch=0; }
  else if (type==='minor') { minor++; patch=0; }
  else { patch++; }
  return `${major}.${minor}.${patch}${rest||''}`;
}

export function updateChangelog(repoRoot: string, version: string, notes: string) {
  const file = path.resolve(repoRoot, 'CHANGELOG.md');
  const date = new Date().toISOString().slice(0,10);
  const entry = `\n## [${version}] - ${date}\n\n${notes.trim()}\n`;
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# Changelog\n\n## [${version}] - ${date}\n\n${notes.trim()}\n`);
  } else {
    const prev = fs.readFileSync(file, 'utf-8');
    // insert after [Unreleased] if present, else append
    const unreleasedIdx = prev.indexOf('## [Unreleased]');
    if (unreleasedIdx >= 0) {
      const before = prev.slice(0, unreleasedIdx + '## [Unreleased]'.length);
      const after = prev.slice(unreleasedIdx + '## [Unreleased]'.length);
      fs.writeFileSync(file, `${before}\n${entry}${after}`);
    } else {
      fs.writeFileSync(file, prev + entry);
    }
  }
}
