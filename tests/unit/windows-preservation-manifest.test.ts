import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { buildWindowsPreservationManifest, normalizeUserProfilePath, redactPreservationValue } from '../../lib/windows-preservation/manifest';
import { buildWindowsProbeExecSpec } from '../../scripts/hii-windows-preservation-audit.mjs';

describe('windows preservation manifest', () => {
  it('redacts credential strings and secret-like keys', () => {
    const manifest = buildWindowsPreservationManifest(
      {
        machine: { os: 'Windows', build: '1.2.3' },
        credentials: { api_key: 'sk-REDACTED-KEY-01234567890', token: 'abc', OPENAI_API_KEY: 'bearer abc' },
        commands: {
          hii: { present: true, path: 'C:\\Users\\alice\\hii.exe', version: '2.0', commandLine: 'hii --token abc' }
        },
        legacyRepo: { path: 'C:\\Users\\alice\\hii', branch: 'main', head: 'cafebabe', dirty: { count: 1, paths: ['C:\\Users\\alice\\file.txt'] } },
        secrets: {
          token: 'eyJtest.token',
          pair: 'key=value',
          auth: 'Bearer 0123456789'
        }
      },
      { mode: 'fixture' }
    );

    expect(manifest.commands.hii.present).toBe(true);
    expect(manifest.commands.hii.path).toContain('%USERPROFILE%');
    expect(manifest.legacyRepo.path).toContain('%USERPROFILE%');
    expect(manifest.legacyRepo.dirty.paths[0]).toContain('%USERPROFILE%');
    expect(normalizeUserProfilePath('C:\\Users\\bob\\notes\\a.txt')).toContain('%USERPROFILE%');
  });

  it('normalizes stale process claims and warnings', () => {
    const manifest = buildWindowsPreservationManifest(
      {
        machine: { os: 'Windows', build: '1.2.3' },
        processes: {
          live: [{ name: 'hii', pid: 100, path: 'C:\\Users\\alice\\hii.exe', startTime: '2026-01-01T00:00:00.000Z' }],
          statusFileClaims: [{ source: 'daemon', pid: 777, expectedRunning: true }]
        }
      },
      { mode: 'fixture', generatedAt: '2026-01-02T00:00:00.000Z' }
    );

    expect(manifest.generatedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(manifest.processEvidence.stale).toBe(true);
    expect(manifest.processEvidence.statusFileClaims[0].stale).toBe(true);
    expect(manifest.processEvidence.live[0].path).toContain('%USERPROFILE%');
    expect(manifest.warnings).toContain('stale daemon state detected');
  });

  it('separates desktop and hii command evidence paths', () => {
    const manifest = buildWindowsPreservationManifest(
      {
        machine: { os: 'Windows', build: '1.2.3' },
        commands: {
          hii: { present: true, path: 'C:\\Users\\alice\\bin\\hii.exe', version: '1.0.0' }
        },
        installedBinary: { path: 'C:\\Users\\alice\\AppData\\Local\\HII\\HII.exe', version: '2.0.0', sizeBytes: 1024, sha256: 'a' }
      },
      { mode: 'fixture' }
    );

    expect(manifest.commands.hii.path).toContain('%USERPROFILE%');
    expect(manifest.installedBinary.path).toContain('%USERPROFILE%');
    expect(manifest.commands.hii.path).not.toBe(manifest.installedBinary.path);
  });

  it('drops route body and reports status metadata', () => {
    const manifest = buildWindowsPreservationManifest(
      {
        machine: { os: 'Windows', build: '1.2.3' },
        port3042: { route: '/api/daemon', status: 'open', statusCode: 200, body: 'should-not-emit' }
      },
      { mode: 'fixture' }
    );

    expect(manifest.port3042.body).toBeNull();
    expect(manifest.port3042.status).toBe('open');
    expect(manifest.port3042.statusCode).toBe(200);
  });

  it('handles DRY_RUN and missing model claims deterministically', () => {
    const manifest = buildWindowsPreservationManifest(
      {
        machine: { os: 'Windows', build: '1.2.3' },
        artifacts: {
          model3dm: { claim: true, exists: false },
          ghLog: { claim: true, exists: true, containsDryRun: true, sizeBytes: 12, path: 'C:\\Users\\alice\\hii\\gh_log.json' }
        }
      },
      { mode: 'fixture' }
    );

    expect(manifest.artifactProof.model3dm.status).toBe('claimed-missing');
    expect(manifest.artifactProof.ghLog.status).toBe('dry-run');
    expect(manifest.warnings).toContain('unverified claimed artifact: model.3dm');
    expect(manifest.warnings).toContain('unverified claimed artifact: gh_log');
  });

  it('verifies model only when existence + size + hash are present', () => {
    const verified = buildWindowsPreservationManifest(
      {
        machine: { os: 'Windows', build: '1.2.3' },
        artifacts: { model3dm: { claim: true, exists: true, sizeBytes: 4, sha256: 'abc' } }
      },
      { mode: 'fixture' }
    );
    const partial = buildWindowsPreservationManifest(
      {
        machine: { os: 'Windows', build: '1.2.3' },
        artifacts: { model3dm: { claim: true, exists: true, sizeBytes: 4 } }
      },
      { mode: 'fixture' }
    );

    expect(verified.artifactProof.model3dm.status).toBe('verified');
    expect(verified.artifactProof.model3dm.verified).toBe(true);
    expect(partial.artifactProof.model3dm.status).toBe('metadata-only');
    expect(partial.artifactProof.model3dm.verified).toBe(false);
  });

  it('adds expected warnings and stale signals from raw flags', () => {
    const manifest = buildWindowsPreservationManifest(
      {
        machine: { os: 'Windows', build: '1.2.3' },
        legacyCliCollision: true,
        epermAtomicRename: true
      },
      { mode: 'fixture' }
    );

    expect(manifest.warnings).toContain('legacy CLI collision detected');
    expect(manifest.warnings).toContain('Windows EPERM atomic rename evidence present');
  });

  it('runs fixture-mode script and emits a manifest from temporary fixture outside repo', () => {
    const dir = mkdtempSync(resolve(tmpdir(), `hii-windows-preservation-${Date.now()}-`));
    const fixturePath = resolve(dir, 'fixture.json');
    writeFileSync(
      fixturePath,
      JSON.stringify({
        generatedAt: '2026-01-02T00:00:00.000Z',
        machine: { os: 'Windows', build: '1.2.3' },
        installedBinary: { path: 'C:\\Users\\alice\\HII.exe', version: '1.0', sizeBytes: 4, sha256: 'deadbeef' },
        port3042: { route: '/api/daemon', status: 'open', statusCode: 200 }
      }),
      'utf8'
    );

    const output = execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve(process.cwd(), 'scripts/hii-windows-preservation-audit.mjs'),
        '--fixture',
        fixturePath
      ],
      { encoding: 'utf8' }
    );

    const result = JSON.parse(output);
    expect(result.schemaVersion).toBe(1);
    expect(result.kind).toBe('hii.windows-preservation/1');
    expect(result.generatedAt).toBe('2026-01-02T00:00:00.000Z');
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses stdin for the probe and does not pass it through ssh argv', () => {
    const { args, input } = buildWindowsProbeExecSpec('hii-pc');

    expect(args).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      'hii-pc',
      'powershell',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '-'
    ]);
    expect(args.includes('-EncodedCommand')).toBe(false);
    expect(args.includes('BatchMode=yes')).toBe(true);
    expect(args.includes('StrictHostKeyChecking=yes')).toBe(true);
    expect(Buffer.isBuffer(input)).toBe(true);
    expect(input.toString('utf8')).toContain("$ProgressPreference = 'SilentlyContinue'");
    expect(input.includes(0)).toBe(false);
  });
});
