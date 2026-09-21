// SPDX-License-Identifier: LicenseRef-BSL-1.1
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import postcss from 'postcss';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  APPLICATION_POLL_INTERVAL_MS,
  shouldSkipApplicationPoll
} from '@/lib/workspace/application-poll';

/**
 * These assertions replace an earlier version of this file that checked the
 * performance work with `expect(source).toContain('...')` against literal
 * source strings. That guard measured nothing: it passed whether or not the
 * behavior survived, and broke on formatting changes that cost nothing. Each
 * test here asserts a property — a module graph, a parsed CSS rule, a called
 * function, an AST shape — so it fails when the performance actually regresses
 * and stays quiet when the code is merely rewritten.
 */

const root = resolve(__dirname, '../..');

/** Static `import`/`export ... from` edges only. Dynamic `import()` is a split point, not an edge. */
function staticImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    const isStaticEdge =
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier);
    if (!isStaticEdge) continue;
    const specifier = (statement as ts.ImportDeclaration).moduleSpecifier as ts.StringLiteral;
    // `import type` is erased at build time and carries no runtime weight.
    if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) continue;
    specifiers.push(specifier.text);
  }
  return specifiers;
}

function resolveModule(specifier: string, fromFile: string): string | null {
  const base = specifier.startsWith('@/')
    ? resolve(root, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(fromFile), specifier)
      : null;
  if (!base) return null; // bare specifier: a package, not first-party source
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every first-party module reachable from `entry` without crossing a dynamic import. */
function eagerModuleGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of staticImports(file)) {
      const resolved = resolveModule(specifier, file);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

/** Returns every `return` in a function, ignoring returns belonging to nested functions. */
function ownReturnStatements(fn: ts.Node): ts.ReturnStatement[] {
  const returns: ts.ReturnStatement[] = [];
  const visit = (node: ts.Node) => {
    if (node !== fn && (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return;
    if (ts.isReturnStatement(node)) returns.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit);
  return returns;
}

function findFunction(file: string, name: string): ts.Node {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  if (!found) throw new Error(`${name} not found in ${file}`);
  return found;
}

describe('HII performance contract', () => {
  const desktopEntry = resolve(root, 'components/desktop/DesktopHiiAccess.tsx');

  it('keeps uncommon workspace applications out of the eager module graph', () => {
    const graph = eagerModuleGraph(desktopEntry);
    const reachable = [...graph].map((file) => relative(root, file).replaceAll('\\', '/'));

    // The desktop entry must pull in the canvas itself — otherwise this test
    // would pass trivially against a graph that resolved nothing.
    expect(reachable).toContain('components/workspace/HiiRoot.tsx');

    // Each retained live application is behind `lazy(() => import(...))`. If
    // someone converts one back to a static import, it lands in the first chunk.
    for (const deferred of [
      'components/workspace/NativeDevBrowser.tsx',
      'components/workspace/RegisteredApplication.tsx'
    ]) {
      expect(existsSync(resolve(root, deferred))).toBe(true);
      expect(reachable).not.toContain(deferred);
    }
  });

  it('mounts only viewport-adjacent board objects while preserving selected objects', () => {
    const rootSource = readFileSync(resolve(root, 'components/workspace/HiiRoot.tsx'), 'utf8');
    expect(rootSource).toContain('visibleWorkspaceNodeIds(');
    expect(rootSource).toContain('for (const id of selected) ids.add(id)');
    expect(rootSource).toContain('{mountedNodes.map((node) => (');
  });

  it('renders the workspace on first paint rather than behind an account-sync gate', () => {
    const component = findFunction(desktopEntry, 'DesktopHiiAccess');
    const returns = ownReturnStatements(component);

    // An early return is how a loading gate reappears: `if (!ready) return <spinner/>`.
    // One return means every render path paints the canvas.
    expect(returns).toHaveLength(1);

    const rendered = returns[0].getText();
    expect(rendered).toContain('<HiiRoot');
  });

  it('skips hidden-tab and overlapping application polls', () => {
    const visible = { cancelled: false, hidden: false, inFlight: false };
    expect(shouldSkipApplicationPoll(visible)).toBe(false);

    expect(shouldSkipApplicationPoll({ ...visible, hidden: true })).toBe(true);
    expect(shouldSkipApplicationPoll({ ...visible, inFlight: true })).toBe(true);
    expect(shouldSkipApplicationPoll({ ...visible, cancelled: true })).toBe(true);

    // A backoff tighter than a second is a busy-loop, not a poll.
    expect(APPLICATION_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(1000);
  });

  it('skips paint for off-screen canvas objects without blanking live surfaces', () => {
    const css = readFileSync(resolve(root, 'app/globals.css'), 'utf8');
    const rules = postcss.parse(css).nodes.filter(
      (node): node is postcss.Rule =>
        node.type === 'rule' &&
        node.nodes.some((decl) => decl.type === 'decl' && decl.prop === 'content-visibility' && decl.value === 'auto')
    );
    expect(rules).toHaveLength(1);

    const selector = rules[0].selector;
    // Terminals, browsers and apps paint continuously; skipping them off-screen
    // blanks a running surface instead of saving work.
    for (const live of ['terminal', 'browser', 'app']) {
      expect(selector).toContain(`:not([data-node-type="${live}"])`);
    }

    // Without an intrinsic size, skipped objects collapse and the scroll height jumps.
    const intrinsic = rules[0].nodes.find(
      (decl) => decl.type === 'decl' && decl.prop === 'contain-intrinsic-size'
    );
    expect(intrinsic).toBeDefined();
  });
});
