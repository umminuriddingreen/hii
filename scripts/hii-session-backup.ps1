param([switch]$Install)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$binary = Join-Path $root 'target\debug\hii.exe'
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'Build the HII CLI before enabling backups.' }

if ($Install) {
    $name = 'HII Session Backup'
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { throw 'The backup task already exists; it was not replaced.' }
    $shell = (Get-Command powershell.exe).Source
    $script = $PSCommandPath
    $action = New-ScheduledTaskAction -Execute $shell -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -File `"$script`"" -WorkingDirectory $root
    $timer = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5)
    $login = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
    $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $name -Action $action -Trigger @($timer, $login) -Principal $principal -Settings $settings -Description 'Local-only incremental Codex, Claude and Pi session backup into HII SQLite.' | Select-Object TaskName, State
    exit 0
}

$env:HII_ROOT = $root
if (-not $env:HII_RUNTIME_DIR) { $env:HII_RUNTIME_DIR = Join-Path $env:USERPROFILE '.hii' }
if (-not $env:HII_DB_PATH) { $env:HII_DB_PATH = Join-Path $env:HII_RUNTIME_DIR 'hii.db' }
$logDirectory = Join-Path $env:HII_RUNTIME_DIR 'logs'
[System.IO.Directory]::CreateDirectory($logDirectory) | Out-Null
$output = & $binary session-backup run 2>&1
$code = $LASTEXITCODE
@("[$([DateTime]::UtcNow.ToString('o'))] exit=$code", $output) | Add-Content -LiteralPath (Join-Path $logDirectory 'session-backup.log') -Encoding utf8
exit $code
