# SPDX-License-Identifier: LicenseRef-BSL-1.1
param(
    [string]$RuntimeDirectory = (Join-Path $env:LOCALAPPDATA 'HII\windows-local-chat-preview'),
    [string]$LlamaServer = 'C:\Users\ummin\llama.cpp-cuda-b10620\bin\llama-server.exe',
    [string]$Model = 'C:\models\qwen3.8-27b\Qwen3.8-27B-UD-IQ3_S.gguf'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$desktop = Join-Path $root 'src-tauri\target\debug\hii.exe'
$cli = Join-Path $root 'target\debug\hii.exe'
foreach ($file in @($desktop, $cli)) {
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Build output missing: $file" }
}
$env:HII_ROOT = $root
$env:HII_RUNTIME_DIR = [IO.Path]::GetFullPath($RuntimeDirectory)
$env:HII_DB_PATH = Join-Path $env:HII_RUNTIME_DIR 'hii.db'
$env:HII_UI_DIR = Join-Path $env:HII_RUNTIME_DIR 'bundled-ui'
$env:HII_UI_URL = ''
$env:HII_ACCOUNT_DIR = Join-Path $env:HII_RUNTIME_DIR 'account'
$env:HII_CLI_BIN = $cli
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $env:HII_RUNTIME_DIR 'webview'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = ''
if (!(Test-Path -LiteralPath $env:HII_DB_PATH)) {
    foreach ($file in @($LlamaServer, $Model)) {
        if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Local inference file missing: $file" }
    }
    & $cli chat settings --endpoint 'http://127.0.0.1:18080/v1' --model-id 'local-qwen' --llama-server $LlamaServer --gguf $Model --managed true
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialize local chat settings' }
}
$process = Start-Process -FilePath $desktop -WorkingDirectory $root -WindowStyle Normal -PassThru
Write-Output "HII Windows preview started (PID $($process.Id)). Select Chat, then Local runtime > Start runtime."
Write-Output "Local database: $env:HII_DB_PATH"
