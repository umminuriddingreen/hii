import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('CLI-only releases can render help without the optional product registry', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hii-inventory-'));
  try {
    mkdirSync(path.join(root, 'scripts'));
    const target = path.join(root, 'scripts', 'hii-inventory.mjs');
    cpSync(new URL('./hii-inventory.mjs', import.meta.url), target);
    const { buildInventory, renderHelp } = await import(pathToFileURL(target));
    const inventory = buildInventory({ live: false });
    assert.deepEqual(inventory.features, []);
    assert.match(renderHelp(inventory), /HII COMMAND MAP/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
