#!/usr/bin/env node
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const BINARY_NAME = process.platform === 'win32' ? 'hii.exe' : 'hii';
const MARKER_FILE = 'current.bin';
const HISTORY_FILE = 'install-history.jsonl';
const RELEASE_MANIFEST_FILE = 'release.json';
const LAUNCHER_BACKUP_ROOT = 'launcher-backups';
const RESOURCE_DIR = 'resources';
const RESOURCE_PATHS = ['aii', 'config', 'scripts', 'browser/dist', 'AGENTS.md', 'package.json'];

const LAUNCHER_TEMPLATE_SHELL = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  '',
  'marker_file="${HII_CLI_RELEASE_MARKER:-{{MARKER_FILE}}}"',
  'source_root={{SOURCE_ROOT}}',
  'if [ -d "${source_root}" ]; then',
  '  export HII_ROOT="${source_root}"',
  'fi',
  '',
  'if [ ! -f "${marker_file}" ]; then',
  '  echo "hii: no HII release marker found at ${marker_file}." >&2',
  '  echo "Install with the release installer first." >&2',
  '  exit 1',
  'fi',
  '',
  'release_binary="$(sed -n "1p" "${marker_file}" | tr -d "\\r")"',
  'if [ -z "${release_binary}" ]; then',
  '  echo "hii: release marker is empty." >&2',
  '  exit 1',
  'fi',
  'if [ ! -x "${release_binary}" ]; then',
  '  echo "hii: release binary is not executable: ${release_binary}" >&2',
  '  exit 1',
  'fi',
  '',
  'exec "${release_binary}" "$@"'
].join('\n');

const LAUNCHER_TEMPLATE_POWERSHELL = [
  '[CmdletBinding(PositionalBinding = $false)]',
  'param(',
  '  [Parameter(ValueFromRemainingArguments = $true)]',
  '  [string[]] $Args,',
  '  [Parameter(ValueFromPipeline = $true)]',
  '  [AllowEmptyString()]',
  '  [string] $HiiPipelineInput',
  ')',
  '',
  '$ErrorActionPreference = \'Stop\'',
  '',
  '$markerFile = if ($env:HII_CLI_RELEASE_MARKER) { $env:HII_CLI_RELEASE_MARKER } else { "{{MARKER_FILE}}" }',
  '$sourceRoot = {{SOURCE_ROOT}}',
  'if (Test-Path -LiteralPath $sourceRoot -PathType Container) {',
  '  $env:HII_ROOT = $sourceRoot',
  '}',
  '',
  'if (-not (Test-Path -LiteralPath $markerFile)) {',
  '  throw "hii: no HII release marker found at $markerFile. Install with the release installer first."',
  '}',
  '',
  '$releaseBinary = (Get-Content -Path $markerFile -TotalCount 1).Trim()',
  'if ([string]::IsNullOrWhiteSpace($releaseBinary)) {',
  '  throw "hii: release marker is empty."',
  '}',
  'if (-not (Test-Path -LiteralPath $releaseBinary)) {',
  '  throw "hii: release binary not found: $releaseBinary"',
  '}',
  '',
  'if ($MyInvocation.ExpectingInput) {',
  '  $HiiPipelineInput | & $releaseBinary @Args',
  '} else {',
  '  & $releaseBinary @Args',
  '}',
  '$exitCode = $LASTEXITCODE',
  'if ($null -ne $exitCode) {',
  '  exit [int]$exitCode',
  '}',
  'exit 0'
].join('\n');

function printUsage() {
  const usage = `
Usage:
  hii-release-installer [--source-root <path> | --source-snapshot <path>]
                        [--source-commit <git-commit>]
                        [--release-root <path>] [--launcher-path <path>]
                        [--dry-run]

Install a host-built hii CLI release into a per-user release root.
`;
  console.log(usage.trim());
}

function parseArgs(argv) {
  const options = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--source-root') {
      options.sourceRoot = argv[++i];
    } else if (arg === '--source-snapshot') {
      options.sourceSnapshot = argv[++i];
    } else if (arg === '--source-commit') {
      options.sourceCommit = argv[++i];
    } else if (arg === '--release-root') {
      options.releaseRoot = argv[++i];
    } else if (arg === '--launcher-path') {
      options.launcherPath = argv[++i];
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  });
  if (result.error) {
    const err = new Error(result.error.message);
    err.exitCode = 1;
    throw err;
  }
  if (typeof result.status !== 'number' || result.status !== 0) {
    const message = result.stderr?.trim() || result.stdout?.trim() || `command failed: ${command}`;
    const error = new Error(message);
    error.exitCode = result.status ?? 1;
    throw error;
  }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 0
  };
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  });
  const status = result.status ?? 1;
  if (result.error) {
    return {
      ok: false,
      status,
      output: result.error.message,
      command: `${command} ${args.join(' ')}`
    };
  }
  return {
    ok: status === 0,
    status,
    output: (result.stdout || result.stderr || '').trim(),
    command: `${command} ${args.join(' ')}`
  };
}

function isTargetBuildPath(filePath) {
  const normalized = filePath.trim().replace(/^"|"$/g, '').replace(/\\/g, '/');
  return normalized.split('/').includes('target');
}

function writeAtomic(filePath, content, mode, preserveExistingPath = null) {
  const parent = path.dirname(filePath);
  mkdirSync(parent, { recursive: true });
  const staging = path.join(
    parent,
    `.hii-release-${process.pid}-${Date.now()}-${path.basename(filePath)}.${Math.floor(Math.random() * 1_000_000)}.tmp`
  );

  writeFileSync(staging, content, { encoding: 'utf8' });
  if (mode !== undefined) {
    chmodSync(staging, mode);
  }

  const hasExisting = existsSync(filePath);
  const backupPath = preserveExistingPath
    ? preserveExistingPath
    : hasExisting && process.platform === 'win32'
      ? path.join(path.dirname(filePath), `.hii-release-${Date.now()}-${process.pid}.bak`)
      : null;

  const cleanup = () => {
    try {
      rmSync(staging, { force: true });
    } catch {
      // ignore cleanup failure
    }
  };

  const renameTarget = () => renameSync(staging, filePath);

  if (hasExisting && preserveExistingPath) {
    try {
      const backupDir = path.dirname(backupPath);
      mkdirSync(backupDir, { recursive: true });
      renameSync(filePath, backupPath);
      renameTarget();
      cleanup();
      return { backupPath, wroteBackup: true };
    } catch (renameError) {
      if (!existsSync(filePath) && backupPath && existsSync(backupPath)) {
        try {
          renameSync(backupPath, filePath);
        } catch {
          // best effort rollback
        }
      }
      cleanup();
      throw renameError;
    }
  }

  try {
    renameTarget();
    cleanup();
    return { backupPath: null, wroteBackup: false };
  } catch (error) {
    if (process.platform !== 'win32' || !hasExisting || !backupPath) {
      cleanup();
      throw error;
    }

    try {
      const backupDir = path.dirname(backupPath);
      mkdirSync(backupDir, { recursive: true });
      renameSync(filePath, backupPath);
      renameTarget();
      cleanup();
      try {
        rmSync(backupPath, { force: true });
      } catch {
        // best effort cleanup
      }
      return { backupPath: null, wroteBackup: false };
    } catch (renameError) {
      if (!existsSync(filePath) && existsSync(backupPath)) {
        try {
          renameSync(backupPath, filePath);
        } catch {
          // best effort rollback
        }
      }
      cleanup();
      throw renameError;
    }
  }
}

function restoreAtomic(filePath, content, mode) {
  if (content === null) {
    try {
      rmSync(filePath, { force: true });
    } catch {
      // best effort rollback
    }
    return;
  }
  writeAtomic(filePath, content, mode);
}

function readMarker(markerFile) {
  if (!existsSync(markerFile)) return null;
  const markerContents = readFileSync(markerFile, 'utf8').trim();
  return markerContents || null;
}

function validateCommit(commit) {
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error(`--source-commit must be a full git commit hash: ${commit}`);
  }
}

function resolveSourceState(sourceRoot, sourceCommitOverride, sourceIsSnapshot) {
  if (sourceIsSnapshot) {
    if (!sourceCommitOverride) {
      throw new Error('source root is not a git repository. use --source-snapshot with --source-commit.');
    }
    validateCommit(sourceCommitOverride);
    return {
      commit: sourceCommitOverride,
      verified: false,
      dirty: false
    };
  }

  const git = process.env.HII_GIT_BIN || 'git';
  let isGitRepo = false;
  try {
    const isInsideWorkTree = runCommand(git, ['-C', sourceRoot, 'rev-parse', '--is-inside-work-tree'], {
      env: process.env
    }).stdout.trim();
    isGitRepo = isInsideWorkTree === 'true';
  } catch {
    isGitRepo = false;
  }

  if (!isGitRepo) {
    throw new Error('source root is not a git repository. use --source-snapshot with --source-commit.');
  }

  const commit = runCommand(git, ['-C', sourceRoot, 'rev-parse', '--verify', 'HEAD'], {
    env: process.env
  }).stdout.trim();

  if (sourceCommitOverride && sourceCommitOverride.toLowerCase() !== commit.toLowerCase()) {
    throw new Error(
      `source commit mismatch: --source-commit ${sourceCommitOverride} does not match HEAD ${commit}`
    );
  }

  const status = runCommand(git, ['-C', sourceRoot, 'status', '--porcelain=v1', '--untracked-files=all'], {
    env: process.env
  }).stdout.trim();

  const statusLines = status.length === 0 ? [] : status.split('\n');
  const isDirty = statusLines.some((line) => {
    const rawPath = line.slice(3);
    if (line.startsWith('??')) {
      const untrackedPath = rawPath.split(' -> ')[0].trim();
      return !isTargetBuildPath(untrackedPath);
    }
    return line.trim().length > 0;
  });

  return {
    commit,
    verified: true,
    dirty: isDirty
  };
}

function sha256(filePath) {
  const digest = createHash('sha256');
  const data = readFileSync(filePath);
  digest.update(data);
  return digest.digest('hex');
}

function sourceBinaryPath(sourceRoot) {
  return path.join(sourceRoot, 'target', 'release', BINARY_NAME);
}

function launcherBackupDir(launcherPath) {
  const launcherDir = path.dirname(launcherPath);
  const token = createHash('sha1')
    .update(`${launcherPath}:${Date.now()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 12);
  return path.join(launcherDir, LAUNCHER_BACKUP_ROOT, token);
}

function detectDefaults(platform, options) {
  const home = process.env.HII_HOME || process.env.HOME || process.env.USERPROFILE;
  if (!home) {
    throw new Error('HOME or USERPROFILE is required');
  }
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const envReleaseRoot = process.env.HII_RELEASE_ROOT;
  const envLauncherPath = process.env.HII_LAUNCHER_PATH;

  const releaseRoot = options.releaseRoot
    || (envReleaseRoot
      ? path.resolve(envReleaseRoot)
      : (platform === 'win32'
        ? path.join(localAppData, 'HII', 'releases', 'hii-cli')
        : path.join(home, '.hii', 'releases', 'hii-cli')));

  const launcherPath = options.launcherPath
    ? path.resolve(options.launcherPath)
    : (envLauncherPath
      ? path.resolve(envLauncherPath)
      : (platform === 'win32'
        ? path.join(appData, 'npm', 'hii.ps1')
        : path.join(home, 'bin', 'hii')));

  const markerFile = path.join(releaseRoot, MARKER_FILE);
  const historyFile = path.join(releaseRoot, HISTORY_FILE);
  const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

  return {
    releaseRoot,
    launcherPath,
    markerFile,
    historyFile,
    scriptRoot
  };
}

function ensureSmoke(binaryPath) {
  const checks = [['--version'], ['--help']];
  let passed;
  for (const args of checks) {
    const smoke = runCapture(binaryPath, args, { cwd: process.cwd(), timeout: 30000 });
    if (smoke.ok) {
      passed = {
        ...smoke,
        commandUsed: args[0]
      };
      break;
    }
  }
  if (!passed) {
    const error = new Error(`binary smoke failed for ${binaryPath}`);
    error.exitCode = 1;
    throw error;
  }
  return passed;
}

function appendLine(filePath, payload) {
  const parent = path.dirname(filePath);
  mkdirSync(parent, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', flag: 'a' });
}

function shellLiteral(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function powerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function makeLauncher(platform, markerFile, resourceRoot) {
  return platform === 'win32'
    ? LAUNCHER_TEMPLATE_POWERSHELL
        .replace('{{MARKER_FILE}}', markerFile)
        .replace('{{SOURCE_ROOT}}', powerShellLiteral(resourceRoot))
    : LAUNCHER_TEMPLATE_SHELL
        .replace('{{MARKER_FILE}}', markerFile)
        .replace('{{SOURCE_ROOT}}', shellLiteral(resourceRoot));
}

function buildBinary(sourceRoot, sourceCargo, commit) {
  const cargo = process.env.HII_CARGO_BIN || 'cargo';
  runCommand(cargo, ['build', '--locked', '--manifest-path', sourceCargo, '--package', 'hii-cli', '--release'], {
    cwd: sourceRoot,
    env: { ...process.env, HII_BUILD_COMMIT: commit }
  });
  const sourceBinary = sourceBinaryPath(sourceRoot);
  if (!existsSync(sourceBinary)) {
    throw new Error(`CLI binary missing after build: ${sourceBinary}`);
  }
  return sourceBinary;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  if (options.sourceRoot && options.sourceSnapshot) {
    throw new Error('use only one of --source-root or --source-snapshot');
  }

  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new Error(`unsupported platform: ${platform}`);
  }

  const defaults = detectDefaults(platform, options);
  const sourceRoot = path.resolve(options.sourceRoot || options.sourceSnapshot || path.resolve(defaults.scriptRoot, '..'));
  if (!existsSync(sourceRoot)) {
    throw new Error(`source root does not exist: ${sourceRoot}`);
  }

  const sourceMarker = resolveSourceState(sourceRoot, options.sourceCommit, Boolean(options.sourceSnapshot));
  if (sourceMarker.dirty && sourceMarker.verified) {
    throw new Error(`source root is dirty: ${sourceRoot}. commit-signed release installs require a clean checkout.`);
  }

  const sourceCargo = path.join(sourceRoot, 'Cargo.toml');
  const cliCargo = path.join(sourceRoot, 'cli', 'Cargo.toml');
  if (!existsSync(sourceCargo) || !existsSync(cliCargo)) {
    throw new Error(`source root is missing Rust manifests: ${sourceCargo}, ${cliCargo}`);
  }

  const commit = sourceMarker.commit;
  const releaseDir = path.join(defaults.releaseRoot, commit);
  const releaseBinary = path.join(releaseDir, BINARY_NAME);
  const resourceRoot = path.join(releaseDir, RESOURCE_DIR);
  const releaseManifestPath = path.join(releaseDir, RELEASE_MANIFEST_FILE);
  const currentMarker = readMarker(defaults.markerFile);
  const alreadyCurrent = currentMarker === releaseBinary;
  const shouldBuild = !existsSync(releaseBinary) || !existsSync(releaseManifestPath) || !existsSync(resourceRoot);
  let buildPerformed = false;

  if (options.dryRun) {
    const dryRunOutput = {
      ok: true,
      action: alreadyCurrent ? 'already-current' : 'planned-install',
      dryRun: true,
      platform,
      sourceRoot,
      sourceCommit: commit,
      sourceCommitVerified: sourceMarker.verified,
      releaseRoot: defaults.releaseRoot,
      releaseDir,
      resourceRoot,
      launcherPath: defaults.launcherPath,
      markerPath: defaults.markerFile,
      wouldRunBuild: shouldBuild,
      launcherBackup: null
    };
    process.stdout.write(`${JSON.stringify(dryRunOutput, null, 2)}\n`);
    return;
  }

  const previousLauncher = existsSync(defaults.launcherPath) ? readFileSync(defaults.launcherPath, 'utf8') : null;
  const previousMarker = currentMarker;
  const previousManifest = existsSync(releaseManifestPath) ? readFileSync(releaseManifestPath, 'utf8') : null;
  const previousHistory = existsSync(defaults.historyFile) ? readFileSync(defaults.historyFile, 'utf8') : null;

  if (shouldBuild) {
    buildBinary(sourceRoot, sourceCargo, commit);
    buildPerformed = true;
    mkdirSync(releaseDir, { recursive: true });
    cpSync(sourceBinaryPath(sourceRoot), releaseBinary);
    if (platform !== 'win32') {
      chmodSync(releaseBinary, 0o755);
    }
    rmSync(resourceRoot, { recursive: true, force: true });
    mkdirSync(resourceRoot, { recursive: true });
    for (const relative of RESOURCE_PATHS) {
      const source = path.join(sourceRoot, relative);
      if (!existsSync(source)) continue;
      cpSync(source, path.join(resourceRoot, relative), { recursive: true });
    }
  }

  if (!existsSync(releaseBinary)) {
    throw new Error(`release binary missing after install path set up: ${releaseBinary}`);
  }

  const smoke = ensureSmoke(releaseBinary);
  const commitShort = sourceMarker.verified
    ? runCommand(process.env.HII_GIT_BIN || 'git', ['-C', sourceRoot, 'rev-parse', '--short', commit], { env: process.env }).stdout.trim()
    : null;

  const releaseManifest = {
    schema: 'hii-release-v2',
    commit,
    sourceRoot,
    sourceCommitVerified: sourceMarker.verified,
    createdAt: new Date().toISOString(),
    releaseBinary,
    releaseRoot: defaults.releaseRoot,
    resourceRoot,
    resourcePaths: RESOURCE_PATHS.filter(relative => existsSync(path.join(resourceRoot, relative))),
    binarySha256: sha256(releaseBinary),
    platform,
    sourceCommitShort: commitShort,
    previousCurrent: previousMarker
  };

  const launcherBody = makeLauncher(platform, defaults.markerFile, resourceRoot);
  const launcherMode = platform === 'win32' ? undefined : 0o755;
  const previousLauncherPath = existsSync(defaults.launcherPath) ? path.resolve(defaults.launcherPath) : null;
  const launcherNeedsUpdate = previousLauncher !== launcherBody;

  let launcherWrite = { backupPath: null, wroteBackup: false };
  let action = alreadyCurrent ? 'already-current' : 'installed';
  const event = {
    action,
    at: new Date().toISOString(),
    platform,
    commit,
    releaseBinary,
    sourceRoot,
    sourceCommitVerified: sourceMarker.verified,
    sourceSnapshot: Boolean(options.sourceSnapshot),
    launcherPath: defaults.launcherPath,
    previousCurrent: previousMarker,
    buildPerformed,
    launcherBackup: null
  };

  try {
    if (launcherNeedsUpdate) {
      const backupPath = previousLauncherPath
        ? path.join(launcherBackupDir(defaults.launcherPath), path.basename(defaults.launcherPath))
        : null;
      launcherWrite = writeAtomic(
        defaults.launcherPath,
        launcherBody,
        launcherMode,
        backupPath
      );
      event.launcherBackup = launcherWrite.backupPath;
      event.action = action;
    }

    writeAtomic(defaults.markerFile, `${releaseBinary}\n`);
    writeAtomic(releaseManifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`);
    appendLine(defaults.historyFile, event);

    const result = {
      ok: true,
      action,
      dryRun: false,
      platform,
      sourceRoot,
      sourceCommit: commit,
      sourceCommitVerified: sourceMarker.verified,
      releaseRoot: defaults.releaseRoot,
      releaseDir,
      releaseBinary,
      resourceRoot,
      launcherPath: defaults.launcherPath,
      markerPath: defaults.markerFile,
      historyPath: defaults.historyFile,
      buildPerformed,
      launcherBackup: launcherWrite.backupPath ?? null,
      smoke
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  } catch (error) {
    if (launcherWrite.wroteBackup && launcherWrite.backupPath && previousLauncher !== null) {
      restoreAtomic(defaults.launcherPath, previousLauncher, launcherMode);
    } else if (previousLauncherPath === null && existsSync(defaults.launcherPath)) {
      restoreAtomic(defaults.launcherPath, null);
    }

    restoreAtomic(defaults.markerFile, previousMarker !== null ? `${previousMarker}\n` : null);
    restoreAtomic(releaseManifestPath, previousManifest);
    restoreAtomic(defaults.historyFile, previousHistory);

    if (launcherWrite.backupPath && existsSync(launcherWrite.backupPath) && launcherNeedsUpdate && previousLauncher !== null) {
      event.launcherBackup = launcherWrite.backupPath;
    }

    throw error;
  }
}

try {
  main();
} catch (error) {
  const exitCode = error.exitCode || 1;
  process.stderr.write(`hii-install-release: ${error.message}\n`);
  process.exit(exitCode);
}
