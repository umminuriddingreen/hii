import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
// @ts-expect-error Operational scripts are native ESM, shared with CI.
import { CLI_TARGETS, verifiedRelease } from '../../scripts/hii-cli-release-publish.mjs';
// @ts-expect-error Operational scripts are native ESM.
import { updaterUrl } from '../../scripts/hii-release-manifest.mjs';

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'hii-distribution-test-'));
  directories.push(directory);
  const sums = CLI_TARGETS.map((target: string) => {
    const filename = `hii-${target}.tar.gz`;
    const content = Buffer.from(`fixture bytes for ${target}`);
    writeFileSync(path.join(directory, filename), content);
    return `${createHash('sha256').update(content).digest('hex')}  ${filename}`;
  }).join('\n');
  writeFileSync(path.join(directory, 'SHA256SUMS'), `${sums}\n`);
  return directory;
}
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe('CLI distribution', () => {
  it('validates every supported archive and publishes the pointer last', () => {
    const directory = fixture();
    expect(verifiedRelease(directory, 'cli-v1.2.3').files).toHaveLength(4);
    const output = execFileSync(process.execPath, ['scripts/hii-cli-release-publish.mjs', directory, 'cli-v1.2.3', '--dry-run'], { encoding: 'utf8' });
    const lines = output.trim().split('\n');
    expect(lines.at(-1)).toBe('verified upload: cli/releases/latest.json');
    expect(output).toContain('cli/releases/cli-v1.2.3/SHA256SUMS');
    expect(output).toContain('cli/releases/cli-v1.2.3/hii-macos-arm64.tar.gz.sha256');
  });

  it('refuses corrupt bytes, missing targets, duplicate checksums, and invalid tags', () => {
    const directory = fixture();
    expect(() => verifiedRelease(directory, '../secret')).toThrow('tag');
    const sums = readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8');
    writeFileSync(path.join(directory, 'SHA256SUMS'), sums + sums);
    expect(() => verifiedRelease(directory, 'cli-v1.2.3')).toThrow('duplicate');
    writeFileSync(path.join(directory, 'SHA256SUMS'), sums.split('\n').slice(1).join('\n'));
    expect(() => verifiedRelease(directory, 'cli-v1.2.3')).toThrow('inventory');
    writeFileSync(path.join(directory, 'SHA256SUMS'), sums);
    writeFileSync(path.join(directory, `hii-${CLI_TARGETS[0]}.tar.gz`), 'corrupt');
    expect(() => verifiedRelease(directory, 'cli-v1.2.3')).toThrow('Checksum mismatch');
  });

  it('pins updater payloads to the versioned channel configured in Tauri', () => {
    expect(updaterUrl('0.1.1', 'HII-0.1.1-macos-aarch64.app.tar.gz')).toBe('https://github.com/umminuriddingreen/hii/releases/download/v0.1.1/HII-0.1.1-macos-aarch64.app.tar.gz');
    expect(() => updaterUrl('0.1.1', '../private')).toThrow();
  });
});
