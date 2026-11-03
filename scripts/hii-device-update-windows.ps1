[CmdletBinding()]
param(
  [string] $BundlePath,
  [string] $Commit,
  [string] $BuildRoot,
  [string] $ProofRoot,
  [string] $SourceRepoPath = (Join-Path $env:USERPROFILE '.hii\build\headless-network-20261011'),
  [switch] $VerifyOnly
)

$ErrorActionPreference = 'Stop'
$script:Commit = $Commit
$script:ProofRoot = if ($ProofRoot) { $ProofRoot } elseif ($BuildRoot) { Join-Path $BuildRoot 'proof' } else { Join-Path $env:USERPROFILE '.hii\auto-update\proof' }
$script:BuildRoot = if ($BuildRoot) { $BuildRoot } else { Join-Path $env:USERPROFILE '.hii\auto-update' }
$script:ReceiptPath = $null
$script:LockStream = $null
$script:OriginalLauncher = $null
$script:OriginalLauncherExists = $false
$script:OriginalMarker = $null
$script:OriginalMarkerExists = $false
$script:PriorHead = $null
$script:PriorBranch = $null
$script:SourceSwitched = $false
$script:MarkerPath = Join-Path $env:LOCALAPPDATA 'HII\releases\hii-cli\current.bin'
$script:LauncherPath = Join-Path $env:APPDATA 'npm\hii.ps1'
$script:ReleaseRoot = Join-Path $env:LOCALAPPDATA 'HII\releases\hii-cli'

function Write-Receipt([string] $Status, [string] $ErrorMessage = $null) {
  $receipt = [ordered]@{
    schema = 'hii-device-update-v1'
    status = $Status
    commit = $script:Commit
    at = [DateTime]::UtcNow.ToString('o')
    error = $ErrorMessage
  }
  if ($script:ReceiptPath) {
    $json = $receipt | ConvertTo-Json -Depth 5
    $tmp = "$script:ReceiptPath.tmp"
    [IO.File]::WriteAllText($tmp, $json + "`n", [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tmp -Destination $script:ReceiptPath -Force
  }
  return $receipt
}

function Emit-Result([bool] $Ok, [string] $Status, [string] $ErrorMessage = $null) {
  $receipt = Write-Receipt $Status $ErrorMessage
  $result = [ordered]@{ ok = $Ok; status = $Status; commit = $script:Commit; receipt = $script:ReceiptPath }
  if ($ErrorMessage) { $result.error = $ErrorMessage }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
}

function Invoke-Bounded([string] $FilePath, [string[]] $ArgumentList, [string] $Name, [string] $WorkingDirectory, [int] $TimeoutSeconds = 1200) {
  $stdout = Join-Path $script:ProofRoot "$Name.stdout.log"
  $stderr = Join-Path $script:ProofRoot "$Name.stderr.log"
  Remove-Item -LiteralPath $stdout,$stderr -Force -ErrorAction SilentlyContinue
  $quoted = @($ArgumentList | ForEach-Object { '"' + ([string]$_).Replace('"','\"') + '"' })
  $p = Start-Process -FilePath $FilePath -ArgumentList ($quoted -join ' ') -WorkingDirectory $WorkingDirectory -PassThru -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  if (-not $p.WaitForExit($TimeoutSeconds * 1000)) {
    try { $p.Kill($true) }
    catch {
      $killer = Start-Process -FilePath 'taskkill.exe' -ArgumentList "/PID $($p.Id) /T /F" -PassThru -WindowStyle Hidden
      if (-not $killer.WaitForExit(10000)) { try { $killer.Kill() } catch {} }
    }
    if (-not $p.WaitForExit(10000)) { throw "$Name timed out and its process tree could not be stopped; do not retry until checked" }
    Limit-Log $stdout; Limit-Log $stderr
    throw "$Name timed out after $TimeoutSeconds seconds"
  }
  $p.WaitForExit()
  Limit-Log $stdout; Limit-Log $stderr
  if ($p.ExitCode -ne 0) { throw "$Name failed with exit code $($p.ExitCode); see owned proof log" }
}

function Limit-Log([string] $Path) {
  if (Test-Path -LiteralPath $Path) {
    $source = [IO.File]::OpenRead($Path)
    try {
      if ($source.Length -gt 262144) {
        $source.Position = $source.Length - 262144
        $tmp = "$Path.tmp"
        $dest = [IO.File]::Create($tmp)
        try {
          $buffer = [byte[]]::new(8192)
          while (($read = $source.Read($buffer, 0, $buffer.Length)) -gt 0) { $dest.Write($buffer, 0, $read) }
        } finally { $dest.Dispose() }
        $source.Dispose()
        Move-Item -LiteralPath $tmp -Destination $Path -Force
      }
    } finally {
      $source.Dispose()
    }
  }
}

function Invoke-Git([string[]] $Arguments, [string] $Repo = $script:SourceRepoPath) {
  $out = & git -C $Repo @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') failed: $($out | Select-Object -Last 1)" }
  return ($out -join "`n").Trim()
}

function Get-FileSha256([string] $Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "required file missing: $Path" }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-InstalledBinary {
  if (-not (Test-Path -LiteralPath $script:MarkerPath -PathType Leaf)) { throw 'installed release marker is missing' }
  $binary = (Get-Content -LiteralPath $script:MarkerPath -TotalCount 1).Trim()
  if (-not $binary) { throw 'installed release marker is empty' }
  $manifestPath = Join-Path (Split-Path -Parent $binary) 'release.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'installed release manifest is missing' }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.commit -ne $script:Commit) { throw 'installed manifest commit does not match requested commit' }
  if ($manifest.sourceCommitVerified -ne $true) { throw 'installed manifest does not record a verified source commit' }
  if ($manifest.releaseBinary -ne $binary) { throw 'installed manifest binary path does not match marker' }
  if ((Get-FileSha256 $binary) -ne $manifest.binarySha256.ToLowerInvariant()) { throw 'installed binary SHA-256 does not match release manifest' }
  return @{ Path = $binary; Manifest = $manifest }
}

function Invoke-InstalledChecks {
  $installed = Get-InstalledBinary
  if (-not (Test-Path -LiteralPath $script:LauncherPath -PathType Leaf)) { throw 'installed launcher is missing' }
  Invoke-Bounded 'powershell.exe' @('-NoProfile','-ExecutionPolicy','Bypass','-File',$script:LauncherPath,'--version') 'installed-version' $script:ProofRoot 60
  $launcher = Get-Content -LiteralPath $script:LauncherPath -Raw
  $helper = Join-Path $env:USERPROFILE '.hii\bin\hii-endpoints.exe'
  if (Test-Path -LiteralPath $helper -PathType Leaf) {
    if ($launcher -notmatch 'hii-endpoints\.exe') { throw 'endpoint helper hook is missing from launcher' }
    Invoke-Bounded 'powershell.exe' @('-NoProfile','-ExecutionPolicy','Bypass','-File',$script:LauncherPath,'endpoint','list') 'endpoint-helper-check' $script:ProofRoot 60
  }
  return $installed
}

function Restore-InstalledPointers {
  if ($script:OriginalLauncherExists) {
    [IO.File]::WriteAllText($script:LauncherPath, $script:OriginalLauncher, [Text.UTF8Encoding]::new($false))
  } else { Remove-Item -LiteralPath $script:LauncherPath -Force -ErrorAction SilentlyContinue }
  if ($script:OriginalMarkerExists) {
    [IO.File]::WriteAllText($script:MarkerPath, $script:OriginalMarker, [Text.UTF8Encoding]::new($false))
  } else { Remove-Item -LiteralPath $script:MarkerPath -Force -ErrorAction SilentlyContinue }
}

try {
  if ($Commit -notmatch '^[0-9a-fA-F]{40}$') { throw 'Commit must be a full 40-character git SHA' }
  $script:Commit = $Commit.ToLowerInvariant()
  New-Item -ItemType Directory -Path $script:ProofRoot,$script:BuildRoot -Force | Out-Null
  $script:ReceiptPath = Join-Path $script:ProofRoot "windows-update-$($script:Commit).json"
  $lockPath = Join-Path $script:BuildRoot 'windows-update.lock'
  $script:LockStream = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $script:LockStream.SetLength(0)
  $lockBytes = [Text.Encoding]::UTF8.GetBytes("pid=$PID`nstarted=$([DateTime]::UtcNow.ToString('o'))`n")
  $script:LockStream.Write($lockBytes, 0, $lockBytes.Length); $script:LockStream.Flush()

  if ($VerifyOnly) {
    $null = Invoke-InstalledChecks
    Emit-Result $true 'verified'
    exit 0
  }

  if (-not $BundlePath) { throw 'BundlePath is required unless VerifyOnly is set' }
  $bundle = (Resolve-Path -LiteralPath $BundlePath).Path

  $script:OriginalLauncherExists = Test-Path -LiteralPath $script:LauncherPath -PathType Leaf
  if ($script:OriginalLauncherExists) { $script:OriginalLauncher = Get-Content -LiteralPath $script:LauncherPath -Raw }
  $script:OriginalMarkerExists = Test-Path -LiteralPath $script:MarkerPath -PathType Leaf
  if ($script:OriginalMarkerExists) { $script:OriginalMarker = Get-Content -LiteralPath $script:MarkerPath -Raw }

  if (-not (Test-Path -LiteralPath $SourceRepoPath -PathType Container)) { throw "trusted source cache missing: $SourceRepoPath" }
  $script:SourceRepoPath = (Resolve-Path -LiteralPath $SourceRepoPath).Path
  $null = Invoke-Git @('bundle','verify',$bundle)
  $dirty = Invoke-Git @('status','--porcelain=v1','--untracked-files=all')
  $dirtyLines = @($dirty -split "`n" | Where-Object { $_ -and -not ($_ -match '^\?\?\s+.*(?:^|[\\/])target(?:[\\/]|$)') })
  if ($dirtyLines.Count -gt 0) { throw 'trusted source cache is dirty; update refused without changing it' }
  $script:PriorHead = Invoke-Git @('rev-parse','--verify','HEAD')
  try { $script:PriorBranch = Invoke-Git @('symbolic-ref','--quiet','--short','HEAD') }
  catch { $script:PriorBranch = $null }

  $null = Invoke-Git @('fetch','--no-tags',$bundle,'HEAD')
  $fetched = Invoke-Git @('rev-parse','--verify','FETCH_HEAD')
  if ($fetched -ne $script:Commit) { throw 'bundle HEAD does not match requested commit' }
  $null = Invoke-Git @('switch','--detach',$script:Commit)
  $script:SourceSwitched = $true

  Invoke-Bounded 'cargo' @('test','--locked','--offline','--manifest-path','cli/Cargo.toml') 'cargo-test' $script:SourceRepoPath
  $requiredNodeTests = @('scripts/hii-code-check.test.mjs','scripts/hii-skill-sync.test.mjs')
  $missingNodeTests = @($requiredNodeTests | Where-Object { -not (Test-Path -LiteralPath (Join-Path $script:SourceRepoPath $_)) })
  if ($missingNodeTests.Count -gt 0) { throw "required Node test gate missing: $($missingNodeTests -join ', ')" }
  $optionalNodeTests = @('scripts/hii-device-auto-update.test.mjs','scripts/hii-device-update-windows.test.mjs')
  $nodeTests = @($requiredNodeTests + $optionalNodeTests) | Where-Object { Test-Path -LiteralPath (Join-Path $script:SourceRepoPath $_) }
  Invoke-Bounded 'node' (@('--test') + $nodeTests) 'node-tests' $script:SourceRepoPath

  $installer = Join-Path $script:SourceRepoPath 'scripts\hii-release-installer.mjs'
  Invoke-Bounded 'node' @($installer,'--source-root',$script:SourceRepoPath,'--source-commit',$script:Commit) 'release-installer' $script:SourceRepoPath

  # The release installer owns the launcher template. Reinsert the previously
  # installed endpoint adapter hook only when its owned helper is present.
  $helperPath = Join-Path $env:USERPROFILE '.hii\bin\hii-endpoints.exe'
  if ((Test-Path -LiteralPath $helperPath -PathType Leaf) -and (Test-Path -LiteralPath $script:LauncherPath -PathType Leaf)) {
    $launcherText = Get-Content -LiteralPath $script:LauncherPath -Raw
    if ($launcherText -notmatch 'hii-endpoints\.exe') {
      $needle = '$markerFile ='
      if (-not $launcherText.Contains($needle)) { throw 'generated launcher has no safe endpoint-hook insertion point' }
      $hook = @'
if ($Args.Count -gt 0 -and $Args[0] -eq 'endpoint') {
  & (Join-Path $env:USERPROFILE '.hii\bin\hii-endpoints.exe') @Args
  exit $LASTEXITCODE
}

'@
      $launcherText = $launcherText.Replace($needle, $hook + $needle)
      [IO.File]::WriteAllText($script:LauncherPath, $launcherText, [Text.UTF8Encoding]::new($false))
    }
  }
  $installed = Invoke-InstalledChecks
  if ($installed.Manifest.commit -ne $script:Commit) { throw 'post-install commit verification failed' }

  # Restore the warm cache to its original branch/head when tests and install
  # leave no tracked or untracked source changes.
  $afterStatus = Invoke-Git @('status','--porcelain=v1','--untracked-files=all')
  if (-not $afterStatus) {
    if ($script:PriorBranch) { $null = Invoke-Git @('switch',$script:PriorBranch) }
    else { $null = Invoke-Git @('switch','--detach',$script:PriorHead) }
    $script:SourceSwitched = $false
  }
  Emit-Result $true 'verified'
  exit 0
} catch {
  $message = $_.Exception.Message
  if ($script:SourceSwitched -and $script:SourceRepoPath -and $script:PriorHead) {
    try {
      $currentStatus = Invoke-Git @('status','--porcelain=v1','--untracked-files=all')
      if (-not $currentStatus) {
        if ($script:PriorBranch) { $null = Invoke-Git @('switch',$script:PriorBranch) }
        else { $null = Invoke-Git @('switch','--detach',$script:PriorHead) }
      } else { $message += '; source cache changed during tests and was left untouched' }
    } catch { $message += '; source cache could not be returned to its prior ref' }
  }
  if (-not $VerifyOnly -and $script:OriginalLauncherExists -or (-not $VerifyOnly -and $script:OriginalMarkerExists)) {
    try { Restore-InstalledPointers } catch { $message += '; pointer rollback failed' }
  }
  try { Emit-Result $false 'failed' $message } catch { [Console]::Out.WriteLine((@{ ok = $false; status = 'failed'; commit = $script:Commit; error = $message } | ConvertTo-Json -Compress)) }
  exit 1
} finally {
  if ($script:LockStream) { $script:LockStream.Dispose() }
}
