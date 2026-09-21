# SPDX-License-Identifier: LicenseRef-BSL-1.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('message.send', 'call.start')]
    [string]$Action,

    [string]$Body,

    [ValidateRange(5, 600)]
    [int]$TimeoutSeconds = 120,

    [string]$MacHost = 'mac',

    [string]$SshConfig = "$env:USERPROFILE\.ssh\config"
)

$ErrorActionPreference = 'Stop'

if ($Action -eq 'message.send') {
    if ([string]::IsNullOrEmpty($Body)) {
        throw 'message.send requires -Body.'
    }
}

if ($Action -eq 'call.start') {
    if (-not [string]::IsNullOrEmpty($Body)) {
        throw 'call.start does not accept -Body.'
    }
}

$request = [ordered]@{
    schema_version = 1
    request_id = [guid]::NewGuid().ToString('D')
    action = $Action
}
if ($Action -eq 'message.send') {
    $request.body = $Body
}

$json = $request | ConvertTo-Json -Compress
$remote = @'
import os
import socket
import sys

payload = sys.stdin.buffer.read()
socket_path = os.path.expanduser("~/.hii/satellite/bridge.sock")
client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.settimeout(float(sys.argv[1]))
client.connect(socket_path)
client.sendall(payload)
client.shutdown(socket.SHUT_WR)
response = bytearray()
while True:
    chunk = client.recv(4096)
    if not chunk:
        break
    response.extend(chunk)
    if b"\n" in response:
        break
sys.stdout.buffer.write(bytes(response))
'@
$remotePayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remote))

$response = ($json + "`n") | & ssh -F $SshConfig -o BatchMode=yes -o ConnectTimeout=10 $MacHost `
    "python3 -c `"import base64;exec(base64.b64decode('$remotePayload'))`" '$TimeoutSeconds'"
if ($LASTEXITCODE -ne 0) {
    throw "Satellite bridge request $($request.request_id) failed with SSH exit code $LASTEXITCODE."
}

$receipt = $response | ConvertFrom-Json
$receipt | ConvertTo-Json -Depth 8
if ($receipt.status -eq 'rejected') {
    exit 2
}
