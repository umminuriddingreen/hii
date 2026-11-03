import { describe, expect, it } from 'vitest';
import { manifestContent, nativeHostDirectory } from '../../scripts/hii-chrome-native-host-install.mjs';

describe('Chromium native host registration', () => {
  it('uses Helium and Chrome native messaging directories', () => {
    expect(nativeHostDirectory('helium', '/tmp/home')).toBe('/tmp/home/Library/Application Support/net.imput.helium/NativeMessagingHosts');
    expect(nativeHostDirectory('chrome', '/tmp/home')).toBe('/tmp/home/Library/Application Support/Google/Chrome/NativeMessagingHosts');
  });

  it('pins one installed extension origin', () => {
    const id = 'a'.repeat(32);
    const manifest = JSON.parse(manifestContent('/tmp/hii-host', id));
    expect(manifest.allowed_origins).toEqual([`chrome-extension://${id}/`]);
  });
});
