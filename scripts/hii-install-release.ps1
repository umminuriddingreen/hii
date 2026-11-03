param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $Args
)

$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot 'hii-release-installer.mjs'

$arguments = @($installer) + $Args
& node @arguments
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
exit 0
