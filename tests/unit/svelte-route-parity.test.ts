import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'../..');
const routes=['+page.svelte','(app)/landing/+page.svelte','(workspace)/knowledge/+page.svelte','(app)/boards/+page.svelte','(app)/console/+page.svelte','(app)/terminal/+page.svelte','(app)/credits/+page.svelte','(app)/dashboard/+page.svelte','(app)/docs/+page.svelte','(app)/docs/[slug]/+page.svelte','(app)/feed/+page.svelte','(app)/login/+page.svelte','(app)/termite/+page.svelte','(app)/upload/+page.svelte','(app)/x/[id]/+page.svelte','models/organic-bridge/+page.svelte'];

describe('Svelte route parity',()=>{it.each(routes)('ships %s',(route)=>expect(existsSync(path.join(root,'src/routes',route))).toBe(true))});
