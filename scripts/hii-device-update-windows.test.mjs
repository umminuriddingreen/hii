import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./hii-device-update-windows.ps1', import.meta.url));
const source = readFileSync(script, 'utf8');

test('Windows receiver exposes bundle and independent verification modes', () => {
  assert.match(source, /\[string\]\s+\$BundlePath/);
  assert.match(source, /\[string\]\s+\$Commit/);
  assert.match(source, /\[switch\]\s+\$VerifyOnly/);
  assert.match(source, /if \(\$VerifyOnly\)\s*\{/);
  assert.match(source, /installed manifest commit does not match requested commit/);
  assert.match(source, /sourceCommitVerified -ne \$true/);
  assert.match(source, /binary SHA-256 does not match release manifest/);
});

test('bundle install is commit addressed, tests before install, and preserves endpoint integration', () => {
  const bundleFetch = source.indexOf("@('fetch','--no-tags',$bundle,'HEAD')");
  const cargoGate = source.indexOf("'cargo-test'");
  const requiredNodeGate = source.indexOf('$requiredNodeTests');
  const installer = source.indexOf("'release-installer'");
  const endpointRestore = source.indexOf("$hook = @'");
  assert.ok(bundleFetch >= 0, 'fetches bundle HEAD');
  assert.ok(cargoGate > bundleFetch && requiredNodeGate > cargoGate && installer > requiredNodeGate, 'required tests precede installation');
  assert.ok(endpointRestore > installer, 'endpoint adapter is restored after installer');
  assert.match(source, /@\('bundle','verify',\$bundle\)/);
  assert.match(source, /trusted source cache is dirty; update refused/);
  assert.match(source, /Restore-InstalledPointers/);
  assert.match(source, /\.Kill\(\$true\)/);
  assert.match(source, /taskkill\.exe/);
  assert.match(source, /source\.Position = \$source\.Length - 262144/);
  assert.match(source, /required Node test gate missing/);
  assert.match(source, /scripts\/hii-code-check\.test\.mjs/);
  assert.match(source, /scripts\/hii-skill-sync\.test\.mjs/);
  assert.match(source, /scripts\/hii-device-auto-update\.test\.mjs/);
  assert.match(source, /scripts\/hii-device-update-windows\.test\.mjs/);
  assert.doesNotMatch(source, /git[^\n]*(?:reset|clean)\b/);
});

test('PowerShell parses when pwsh is available', (t) => {
  const probe = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
  if (probe.error?.code === 'ENOENT') return t.skip('pwsh is not installed on this build host');
  assert.equal(probe.status, 0, probe.stderr);
  const parsed = spawnSync('pwsh', ['-NoProfile', '-Command', `$null = [scriptblock]::Create([IO.File]::ReadAllText('${script.replaceAll("'", "''")}'))`], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
});
