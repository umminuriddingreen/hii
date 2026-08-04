import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const rust = readFileSync(resolve(root, 'src-tauri/src/lib.rs'), 'utf8');
const workspace = readFileSync(resolve(root, 'src/lib/components/workspace/WorkspacePage.svelte'), 'utf8');
const systemSpace = readFileSync(resolve(root, 'src/lib/components/workspace/SystemSpace.svelte'), 'utf8');
const development = readFileSync(resolve(root, 'src/lib/components/workspace/DevelopmentSessionPane.svelte'), 'utf8');

describe('HII OS overlay contract', () => {
  it('routes native menu commands into live workspace actions', () => {
    for (const event of ['command-palette', 'open-browser', 'fit-all', 'space-refresh', 'develop-hii']) {
      expect(rust).toContain(`hii://${event}`);
      expect(workspace).toContain(`hii://${event}`);
    }
    expect(rust).toContain('Open or Focus HII Workspace');
  });

  it('projects system spaces and self-development into the shared canvas', () => {
    expect(systemSpace).toContain("fetch('/api/space')");
    expect(systemSpace).toContain("action:'switch-space'");
    expect(workspace).toContain('developmentSession:true');
    expect(development).toContain("fetch('/api/development/session'");
    expect(development).toContain('HII hot development preview');
    expect(development).toContain('HII Preview.app');
  });
});
