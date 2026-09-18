# HII's native Windows launcher. Model configuration belongs to the runtime.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$hiiInstallRoot = Join-Path $env:USERPROFILE '.hii\install-root'
$hiiRepo = if ($env:HII_ROOT) { $env:HII_ROOT } elseif (Test-Path -LiteralPath $hiiInstallRoot) { (Get-Content -LiteralPath $hiiInstallRoot -Raw).Trim() } else { Join-Path $env:USERPROFILE 'hii' }
$hiiBinary = if ($env:HII_CLI_BIN) { $env:HII_CLI_BIN } else { Join-Path $hiiRepo 'target\release\hii.exe' }
$env:HII_ROOT = $hiiRepo
if (-not (Test-Path -LiteralPath $hiiBinary -PathType Leaf)) {
    $hiiCargo = if ($env:HII_CARGO_BIN) { $env:HII_CARGO_BIN } else { 'cargo' }
    & $hiiCargo build --manifest-path (Join-Path $hiiRepo 'Cargo.toml') --package hii-cli --release --locked --quiet
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
if (-not (Test-Path -LiteralPath $hiiBinary -PathType Leaf)) { throw "HII CLI is unavailable at $hiiBinary" }
# Windows PowerShell 5 flattens native argv and can lose embedded quotes.
# Build the Windows argv representation explicitly without evaluating it.
function ConvertTo-HiiNativeArgument([string] $value) {
    $quoted = [regex]::Replace($value, '(\\*)"', '$1$1\"')
    $quoted = [regex]::Replace($quoted, '(\\+)$', '$1$1')
    return '"' + $quoted + '"'
}
$hiiProcessInfo = New-Object System.Diagnostics.ProcessStartInfo
$hiiProcessInfo.FileName = $hiiBinary
$hiiProcessInfo.UseShellExecute = $false
$hiiProcessInfo.Arguments = (($Args | ForEach-Object { ConvertTo-HiiNativeArgument ([string] $_) }) -join ' ')
$hiiProcess = [System.Diagnostics.Process]::Start($hiiProcessInfo)
try {
    $hiiProcess.WaitForExit()
    $hiiExitCode = $hiiProcess.ExitCode
} finally {
    $hiiProcess.Dispose()
}
exit $hiiExitCode
