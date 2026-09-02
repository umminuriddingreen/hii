$ErrorActionPreference = 'Stop'

# What a packaged Windows HII has to prove, in the order a user meets it:
# the installer exists, installs per-user without an administrator, places the
# app where the app itself expects to find it, ships a working `hii.exe`
# sidecar, and launches. The old steps 6-8 polled an embedded Node server on
# 127.0.0.1:3042 that no longer exists — the app is a static export served over
# hiiui:// with no HTTP surface at all — so they proved nothing and would fail
# on a perfectly good build.

if ($env:OS -ne 'Windows_NT') {
  throw 'hii-windows-packaged-smoke.ps1 requires Windows.'
}

$repo = Split-Path -Parent $PSScriptRoot
$installer = Get-ChildItem -Path (Join-Path $repo 'src-tauri\target\release\bundle\nsis') -Filter '*-setup.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $installer) {
  throw 'HII NSIS installer was not produced.'
}

Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait

$candidates = @(
  (Join-Path $env:LOCALAPPDATA 'HII\hii.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\HII\hii.exe')
)
$app = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $app) {
  $app = Get-ChildItem -Path $env:LOCALAPPDATA -Filter 'HII.exe' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $app) {
  throw 'The NSIS installer completed, but HII.exe was not installed for the current user.'
}
if ($app -notlike "$env:LOCALAPPDATA*") {
  throw "HII installed outside the per-user location: $app"
}

# The sidecar. src-tauri/src/lib.rs resolves the CLI from the resource
# directory beside the executable; a bundle that ships without it launches fine
# and then fails at the first agent run.
#
# Order matters: the Tauri app binary and the CLI are both named hii.exe, and
# the app sits in the install root. Only resources\hii.exe is the CLI. Probing
# the root first launches the GUI and gets no version back.
$installRoot = Split-Path -Parent $app
$cli = @(
  (Join-Path $installRoot 'resources\hii.exe'),
  (Join-Path $installRoot 'resources\resources\hii.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $cli) {
  throw "The installed bundle has no hii.exe sidecar under $installRoot."
}

$version = & $cli --version 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "The bundled hii.exe did not run: $version"
}

# A read-only command that exercises the runtime root. This is where the Rust
# and TypeScript halves used to disagree on Windows about where ~/.hii lives.
$home_json = & $cli home --json 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "The bundled hii.exe could not read its runtime root: $home_json"
}
try {
  $null = $home_json | ConvertFrom-Json
} catch {
  throw "hii home --json did not return JSON: $home_json"
}

# Terminal objects. The canvas puts real shells on the surface, and this is the
# CLI half of that contract: it writes a terminal object into the Runtime
# document with a working directory the app will spawn ConPTY in. Pointed at a
# throwaway runtime root so the smoke never edits the real canvas. Spawning the
# ConPTY itself is the app's job and is covered by the launch step below.
$scratchRuntime = Join-Path $env:TEMP ("hii-smoke-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratchRuntime -Force | Out-Null
try {
  $terminal = & { $env:HII_RUNTIME_DIR = $scratchRuntime; & $cli terminal $scratchRuntime --json 2>&1 }
  if ($LASTEXITCODE -ne 0) {
    throw "The bundled hii.exe could not create a terminal object: $terminal"
  }
  $terminalObject = $terminal | ConvertFrom-Json
  if ($terminalObject.node.object.kind -ne 'terminal' -or $terminalObject.node.object.status -ne 'ready') {
    throw "hii terminal did not return a ready terminal object: $terminal"
  }
} finally {
  Remove-Item -Recurse -Force $scratchRuntime -ErrorAction SilentlyContinue
  Remove-Item Env:\HII_RUNTIME_DIR -ErrorAction SilentlyContinue
}

$process = Start-Process -FilePath $app -PassThru
try {
  # WebView2 initialisation and the first paint take a few seconds cold. The
  # proof is that the process is still alive after it, not that it crashed on a
  # missing runtime or a bad hiiui:// registration.
  Start-Sleep -Seconds 12
  $alive = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
  if (-not $alive) {
    $log = Join-Path $env:USERPROFILE '.hii\logs\desktop.log'
    if (Test-Path $log) { Get-Content $log -Tail 120 }
    throw "Installed HII exited during startup (code $($process.ExitCode))."
  }

  Write-Host "Windows installer: $($installer.FullName)"
  Write-Host "Installed app: $app"
  Write-Host "Bundled CLI: $cli ($version)"
  Write-Host 'Windows packaged proof: per-user install, sidecar CLI, runtime root, and launch passed.'
} finally {
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
}
