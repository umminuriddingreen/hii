$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
  throw 'hii-windows-packaged-smoke.ps1 requires Windows.'
}

$repo = Split-Path -Parent $PSScriptRoot
$installer = Get-ChildItem -Path (Join-Path $repo 'src-tauri\target\release\bundle\nsis') -Filter '*-setup.exe' | Select-Object -First 1
if (-not $installer) {
  throw 'HII NSIS installer was not produced.'
}

Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait

$candidates = @(
  (Join-Path $env:LOCALAPPDATA 'HII\HII.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\HII\HII.exe')
)
$app = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $app) {
  $app = Get-ChildItem -Path $env:LOCALAPPDATA -Filter 'HII.exe' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $app) {
  throw 'The NSIS installer completed, but HII.exe was not installed for the current user.'
}

$process = Start-Process -FilePath $app -PassThru
try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3042/api/knowledge' -TimeoutSec 2
      if ($response.StatusCode -eq 200 -and $response.Content -match 'hii-database') {
        $ready = $true
        break
      }
    } catch {
      # The embedded server and WebView2 can take a few seconds on first launch.
    }
  }
  if (-not $ready) {
    $log = Join-Path $env:USERPROFILE '.hii\logs\desktop-server.log'
    if (Test-Path $log) { Get-Content $log -Tail 120 }
    throw 'Installed HII did not expose its local application server.'
  }

  $start = Invoke-RestMethod -Method Post -ContentType 'application/json' -Body '{"action":"start"}' -Uri 'http://127.0.0.1:3042/api/daemon'
  if ($start.action -ne 'start') { throw 'HII did not accept the embedded AII start request.' }

  $alive = $false
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    $snapshot = Invoke-RestMethod -Uri 'http://127.0.0.1:3042/api/daemon'
    if ($snapshot.alive -eq $true) {
      $alive = $true
      break
    }
  }
  if (-not $alive) { throw 'The embedded AII daemon did not become ready on Windows.' }
  Invoke-RestMethod -Method Post -ContentType 'application/json' -Body '{"action":"stop"}' -Uri 'http://127.0.0.1:3042/api/daemon' | Out-Null

  Write-Host "Windows installer: $($installer.FullName)"
  Write-Host "Installed app: $app"
  Write-Host 'Windows packaged proof: launch, local server, and embedded AII start/stop passed.'
} finally {
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
}
