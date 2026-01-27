import fs from 'node:fs';
import path from 'node:path';

export type GraphNode = { id: string; title: string; path: string; type: 'note'|'tag' };
export type GraphEdge = { source: string; target: string; kind: 'link'|'tag' };
export type VaultGraph = { nodes: GraphNode[]; edges: GraphEdge[] };

function listMarkdownFiles(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '.obsidian') continue;
        walk(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

function titleFromPath(p: string): string { return path.basename(p).replace(/\.md$/i, ''); }

export function buildVaultGraph(vaultPath: string): VaultGraph {
  const files = listMarkdownFiles(vaultPath);
  const idOf = (p: string) => path.relative(vaultPath, p);
  const titleToId = new Map<string, string>();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const f of files) {
    const id = idOf(f);
    const title = titleFromPath(f);
    nodes.push({ id, title, path: f, type: 'note' });
    titleToId.set(title, id);
  }

  const linkRe = /\[\[([^\]\|#]+)(?:#[^\]]*)?(?:\|[^\]]*)?\]\]|\[[^\]]*\]\(([^)]+)\)/g;
  const tagRe = /(^|\s)#([A-Za-z0-9_\-/]+)/g;

  for (const f of files) {
    const fromId = idOf(f);
    const text = fs.readFileSync(f, 'utf-8');
    let m: RegExpExecArray | null;
    // Wikilinks and markdown links
    while ((m = linkRe.exec(text))) {
      const wiki = m[1];
      const md = m[2];
      let targetId: string | undefined;
      if (wiki) {
        const t = wiki.trim();
        targetId = titleToId.get(t);
        if (!targetId && t.toLowerCase().endsWith('.md')) {
          // direct filename link
          const abs = path.join(vaultPath, t);
          if (fs.existsSync(abs)) targetId = idOf(abs);
        }
      } else if (md) {
        // resolve relative links to md files within vault
        const rel = md.split('#')[0];
        if (/^\.\.?\//.test(rel) || !/^[a-z]+:\/\//i.test(rel)) {
          const abs = path.resolve(path.dirname(f), rel);
          if (abs.toLowerCase().endsWith('.md') && fs.existsSync(abs)) targetId = idOf(abs);
        }
      }
      if (targetId) edges.push({ source: fromId, target: targetId, kind: 'link' });
    }
    // Tags
    while ((m = tagRe.exec(text))) {
      const tag = m[2];
      const tagId = `#${tag}`;
      if (!nodes.find(n => n.id === tagId)) nodes.push({ id: tagId, title: `#${tag}`, path: '', type: 'tag' });
      edges.push({ source: fromId, target: tagId, kind: 'tag' });
    }
  }

  return { nodes, edges };
}

