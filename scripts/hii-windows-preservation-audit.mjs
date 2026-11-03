#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { buildWindowsPreservationManifest } from '../lib/windows-preservation/manifest.ts';

const args = process.argv.slice(2);
const fixturePath = parseArg('--fixture');
const outPath = parseArg('--out');
const sshAlias = parseArg('--ssh-alias', 'hii-pc');
const ALIAS_RE = /^[A-Za-z0-9._-]+$/;

function parseArg(name, fallback = null) {
  const index = args.indexOf(name);
  if (index >= 0 && index + 1 < args.length) return args[index + 1];
  return fallback;
}

const PS_PROBE = `$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'

$legacyRoot = Join-Path $env:USERPROFILE 'hii-test'
$runtimeRoot = Join-Path $env:USERPROFILE '.hii'
$runtimePaths = [ordered]@{
  capabilities = Join-Path $runtimeRoot 'capabilities.json'
  skills = Join-Path $runtimeRoot 'skills'
  memories = Join-Path $runtimeRoot 'memory'
  artifacts = Join-Path $runtimeRoot 'artifacts'
}
$archRoot = Join-Path $runtimePaths.artifacts 'arch-design'
$hiiDesktop = Join-Path $env:LOCALAPPDATA 'HII\\HII.exe'
$statusPath = Join-Path $runtimeRoot 'daemon\\status.json'
$eventsPath = Join-Path $runtimeRoot 'daemon\\events.jsonl'

$probe = [ordered]@{
  machine = @{ os = 'unknown'; build = 'unknown' }
  legacyRepo = @{
    path = $legacyRoot
    branch = 'unknown'
    head = 'unknown'
    dirty = @{ count = 0; paths = @() }
  }
  installedBinary = @{ path = $null; version = 'unknown'; sizeBytes = 0; sha256 = $null }
  commands = @{
    hii = @{ present = $false; path = $null; version = 'unknown' }
    codex = @{ present = $false; path = $null; version = 'unknown' }
    claude = @{ present = $false; path = $null; version = 'unknown' }
    ollama = @{ present = $false; path = $null; version = 'unknown' }
  }
  processes = @{ live = @(); statusFileClaims = @(); stale = $false }
  port3042 = @{ route = '/api/daemon'; status = 'unknown'; statusCode = $null; body = $null }
  inventory = @{
    capabilities = @{ count = 0; paths = @('.hii/capabilities.json'); metadata = @() }
    skills = @{ count = 0; paths = @('.hii/skills'); metadata = @() }
    memories = @{ count = 0; paths = @('.hii/memory'); metadata = @() }
    artifacts = @{ count = 0; paths = @('.hii/artifacts'); metadata = @() }
  }
  artifacts = @{
    model3dm = @{ claim = $false; exists = $false; path = $null; sizeBytes = $null; sha256 = $null }
    ghLog = @{ claim = $false; exists = $false; path = $null; sizeBytes = $null; lastSeenAt = $null; containsDryRun = $false }
  }
  warnings = @()
  legacyCliCollision = $false
  epermAtomicRename = $false
  stale = $false
}

function Resolve-CommandData($name) {
  try {
    $entry = Get-Command $name -ErrorAction Stop
  } catch {
    return @{ present = $false; path = $null; version = 'unknown' }
  }
  $version = 'unknown'
  try {
    $version = (& $name --version).Trim()
  } catch { }
  return @{ present = $true; path = $entry.Source; version = [string]$version }
}

function Count-Files($path) {
  if (-not (Test-Path $path -PathType Container)) { return 0 }
  try {
    return (Get-ChildItem -Path $path -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
  } catch {
    return 0
  }
}

try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
  $probe.machine.os = $os.Caption
  $probe.machine.build = [string](Get-ItemPropertyValue -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' -Name CurrentBuildNumber -ErrorAction Stop)
} catch { }

$probe.commands.hii = Resolve-CommandData 'hii'
$probe.commands.codex = Resolve-CommandData 'codex'
$probe.commands.claude = Resolve-CommandData 'claude'
$probe.commands.ollama = Resolve-CommandData 'ollama'

if (Test-Path $hiiDesktop -PathType Leaf) {
  $probe.installedBinary.path = $hiiDesktop
  try {
    $binary = Get-Item -LiteralPath $hiiDesktop -ErrorAction Stop
    $probe.installedBinary.sizeBytes = [int64]$binary.Length
    $probe.installedBinary.sha256 = (Get-FileHash -Path $hiiDesktop -Algorithm SHA256 -ErrorAction Stop).Hash
    $versionInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($hiiDesktop)
    $probe.installedBinary.version = $versionInfo.FileVersion
    if (-not $probe.installedBinary.version -or [string]::IsNullOrWhiteSpace($probe.installedBinary.version)) {
      $probe.installedBinary.version = $versionInfo.ProductVersion
    }
  } catch { }
}

if (Test-Path $legacyRoot -PathType Container) {
  $probe.legacyRepo.path = $legacyRoot
  try { $probe.legacyRepo.branch = (& git -C $legacyRoot rev-parse --abbrev-ref HEAD).Trim() } catch { }
  try { $probe.legacyRepo.head = (& git -C $legacyRoot rev-parse HEAD).Trim() } catch { }
  try {
    $dirty = (& git -C $legacyRoot status --short)
    if ($dirty) {
      $lines = $dirty -split '\r?\n' | Where-Object { $_ -ne '' }
      foreach ($line in $lines) {
        $parts = (($line -replace '^..\\s*','') -split '\\s+')
        if ($parts.Count -gt 0) { $probe.legacyRepo.dirty.paths += $parts[0] }
      }
      $probe.legacyRepo.dirty.count = $probe.legacyRepo.dirty.paths.Count
    }
  } catch { }
}

$probe.inventory.capabilities.count = if (Test-Path $runtimePaths.capabilities -PathType Leaf) { 1 } else { 0 }
$probe.inventory.skills.count = Count-Files $runtimePaths.skills
$probe.inventory.memories.count = Count-Files $runtimePaths.memories
$probe.inventory.artifacts.count = Count-Files $runtimePaths.artifacts

foreach ($proc in (Get-Process -ErrorAction SilentlyContinue)) {
  if ($proc.ProcessName -notin @('hii', 'node', 'hii.exe', 'HII')) { continue }
  $entry = [ordered]@{
    name = $proc.ProcessName
    pid = $proc.Id
    path = $proc.Path
    startTime = try { $proc.StartTime.ToString('o') } catch { $null }
  }
  $probe.processes.live += $entry
}

if (Test-Path $statusPath -PathType Leaf) {
  try {
    $statusRaw = Get-Content -Raw -LiteralPath $statusPath -ErrorAction Stop
    $status = $statusRaw | ConvertFrom-Json -ErrorAction Stop
    $claims = @()
    if ($status.state -is [string] -and $status.pid) {
      $claims = @(@{ source = 'daemon'; pid = [int]$status.pid; state = $status.state; expectedRunning = $true })
    } elseif ($status.state -is [array]) { $claims = $status.state }
    elseif ($status.daemon -is [array]) { $claims = $status.daemon }
    elseif ($status.pids -is [array]) {
      $claims = $status.pids | ForEach-Object { @{ source = 'daemon'; pid = $_; state = 'running' } }
    } elseif ($status.hii -is [array]) {
      $claims = $status.hii | ForEach-Object { @{ source = 'hii'; pid = $_.pid; state = $_.state } }
    } elseif ($status.node -is [array]) {
      $claims = $status.node | ForEach-Object { @{ source = 'node'; pid = $_.pid; state = $_.state } }
    }
    foreach ($entry in $claims) {
      if ($entry.pid) {
        $probe.processes.statusFileClaims += @{ source = $entry.source; pid = [int]$entry.pid; state = $entry.state; expectedRunning = $true }
      }
    }
  } catch { }
}

try {
  $response = Invoke-WebRequest -Uri 'http://127.0.0.1:3042/api/daemon' -UseBasicParsing -TimeoutSec 3
  $probe.port3042.status = if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) { 'open' } else { 'closed' }
  $probe.port3042.statusCode = [int]$response.StatusCode
} catch {
  $probe.port3042.status = 'closed'
}

$candidateModel = Get-ChildItem -Path $archRoot -Recurse -Filter 'model.3dm' -File -ErrorAction SilentlyContinue |
  Sort-Object -Property LastWriteTime -Descending |
  Select-Object -First 1
if ($candidateModel) {
  $candidateModelPath = $candidateModel.FullName
  $probe.artifacts.model3dm.claim = $true
  $probe.artifacts.model3dm.exists = $true
  $probe.artifacts.model3dm.path = $candidateModelPath
  $info = Get-Item -LiteralPath $candidateModelPath -ErrorAction Stop
  $probe.artifacts.model3dm.sizeBytes = [int64]$info.Length
  $probe.artifacts.model3dm.sha256 = (Get-FileHash -Path $candidateModelPath -Algorithm SHA256 -ErrorAction Stop).Hash
}

$candidateLog = Get-ChildItem -Path $archRoot -Recurse -Filter 'gh_log.json' -File -ErrorAction SilentlyContinue |
  Sort-Object -Property LastWriteTime -Descending |
  Select-Object -First 1
if ($candidateLog) {
  $candidateLogPath = $candidateLog.FullName
  $probe.artifacts.ghLog.claim = $true
  $probe.artifacts.ghLog.exists = $true
  $probe.artifacts.ghLog.path = $candidateLogPath
  $info = Get-Item -LiteralPath $candidateLogPath -ErrorAction Stop
  $probe.artifacts.ghLog.sizeBytes = [int64]$info.Length
  $probe.artifacts.ghLog.lastSeenAt = $info.LastWriteTime.ToString('o')
  try {
    $probe.artifacts.ghLog.containsDryRun = (Get-Content -Path $candidateLogPath -Tail 400 -ErrorAction Stop | Select-String -Pattern 'DRY_RUN' -Quiet)
  } catch { $probe.artifacts.ghLog.containsDryRun = $false }
}

  try {
    $hiiCandidates = @(where.exe hii 2>$null | Where-Object { $_ }) | Select-Object -Unique
    $hasMultipleCandidates = $hiiCandidates.Count -gt 1
    $legacyRepoExists = Test-Path $legacyRoot -PathType Container
    $hiiFromPathSeparate = (
      $legacyRepoExists -and
      $probe.commands.hii.path -and
      $probe.installedBinary.path -and
      ($probe.commands.hii.path -ne $probe.installedBinary.path)
    )
    if ($hasMultipleCandidates -or $hiiFromPathSeparate) { $probe.legacyCliCollision = $true }
  } catch { }

try {
  if (Test-Path $eventsPath -PathType Leaf) {
    $probe.epermAtomicRename = (Get-Content -Path $eventsPath -Tail 400 -ErrorAction Stop | Select-String -Pattern 'EPERM' -SimpleMatch -Quiet)
  }
} catch { }

if ($probe.legacyCliCollision) { $probe.warnings += 'legacy CLI collision detected' }
if ($probe.processes.stale) { $probe.warnings += 'stale daemon state detected' }
if ($probe.epermAtomicRename) { $probe.warnings += 'Windows EPERM atomic rename evidence present' }
if ($probe.artifacts.model3dm.claim -and -not $probe.artifacts.model3dm.exists) { $probe.warnings += 'unverified claimed artifact: model.3dm' }
if ($probe.artifacts.ghLog.claim -and -not $probe.artifacts.ghLog.exists) { $probe.warnings += 'unverified claimed artifact: gh_log' }
$probe.warnings = $probe.warnings | Sort-Object -Unique
$probe.generatedAt = (Get-Date).ToString('o')

ConvertTo-Json -InputObject $probe -Depth 8
`;

function stableStringify(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(stableStringify);
  if (typeof value === 'object') {
    const ordered = {};
    for (const key of Object.keys(value).sort()) {
      ordered[key] = stableStringify(value[key]);
    }
    return ordered;
  }
  return value;
}

function normalizeJsonOutput(text) {
  const payload = String(text);
  const start = payload.indexOf('{');
  const end = payload.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('missing JSON payload');
  }
  return payload.slice(start, end + 1);
}

function writeOutput(payload) {
  if (outPath) {
    writeFileSync(resolve(process.cwd(), outPath), `${payload}\n`, 'utf8');
    return;
  }
  console.log(payload);
}

export function buildWindowsProbeExecSpec(alias = sshAlias) {
  if (!ALIAS_RE.test(alias)) {
    throw new Error(`invalid ssh alias: ${alias}`);
  }
  return {
    args: ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', alias, 'powershell', '-NoProfile', '-NonInteractive', '-Command', '-'],
    input: Buffer.from(`${PS_PROBE}\r\n`, 'utf8')
  };
}

function runFixtureMode() {
  const raw = JSON.parse(readFileSync(resolve(process.cwd(), fixturePath), 'utf8'));
  const manifest = buildWindowsPreservationManifest(raw, { mode: 'fixture', alias: sshAlias, generatedAt: raw.generatedAt });
  writeOutput(JSON.stringify(stableStringify(manifest), null, 2));
}

function runLiveMode() {
  const { args, input } = buildWindowsProbeExecSpec();
  const rawText = execFileSync('ssh', args, {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const parsed = JSON.parse(normalizeJsonOutput(rawText));
  const manifest = buildWindowsPreservationManifest(parsed, {
    mode: 'live',
    alias: sshAlias,
    generatedAt: parsed.generatedAt
  });
  writeOutput(JSON.stringify(stableStringify(manifest), null, 2));
}

function main() {
  if (fixturePath) {
    return runFixtureMode();
  }

  return runLiveMode();
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!ALIAS_RE.test(sshAlias)) {
    console.error(`invalid ssh alias: ${sshAlias}`);
    process.exit(1);
  }
  main();
}
