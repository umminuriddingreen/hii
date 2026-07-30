import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'../..');
// Commerce, auth and legacy demo surfaces were parked in ~/dev/hii-parked; the
// routes below are the ones HII still ships.
const routes=['+page.svelte','(app)/landing/+page.svelte','(workspace)/knowledge/+page.svelte','(app)/boards/+page.svelte','(app)/console/+page.svelte','(app)/docs/+page.svelte','(app)/docs/[slug]/+page.svelte','(app)/activate/+page.svelte','(app)/pilot/+page.svelte','palette/+page.svelte'];

describe('Svelte route parity',()=>{it.each(routes)('ships %s',(route)=>expect(existsSync(path.join(root,'src/routes',route))).toBe(true))});
