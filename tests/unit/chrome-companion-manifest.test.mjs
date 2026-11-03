import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('HII Companion manifest', () => {
  it('keeps broad browser sources optional and contains no ambient page index', async () => {
    const manifest = JSON.parse(await readFile('extensions/chrome-link-capture/manifest.json', 'utf8'));
    const background = await readFile('extensions/chrome-link-capture/background.js', 'utf8');
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(['activeTab', 'contextMenus', 'nativeMessaging']);
    expect(manifest.optional_permissions).toEqual(['bookmarks', 'history', 'tabs', 'scripting']);
    expect(manifest.optional_host_permissions).toEqual(['http://*/*', 'https://*/*']);
    expect(background).not.toContain('registerContentScripts');
    expect(background).not.toContain('index-page');
    expect(background).toContain('import-browser-library');
  });
});
