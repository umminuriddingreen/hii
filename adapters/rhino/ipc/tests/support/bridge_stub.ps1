# A stand-in for the C# bridge, built on the same .NET API the real plug-in
# will use: System.IO.Pipes.NamedPipeServerStream in byte mode.
#
# The point is not to simulate Rhino. It is to prove, before a single line of
# the plug-in is written, that .NET and Rust agree on the framing: byte mode,
# a little-endian uint32 length, then UTF-8 JSON. A mismatch here — message
# mode, a big-endian prefix, a stray newline — produces perfectly valid JSON on
# both sides and a bridge that cannot talk.
#
# The JSON itself is written by the Rust test and only read here, so this script
# cannot drift from the protocol types.

param(
    [Parameter(Mandatory = $true)][string] $PipeName,
    [Parameter(Mandatory = $true)][string] $HandshakePath,
    [Parameter(Mandatory = $true)][string] $EventPath,
    [Parameter(Mandatory = $true)][string] $ResponseTemplatePath,
    [Parameter(Mandatory = $true)][string] $ReadyPath,
    # Keep reading, but never answer a request. Used to prove a client write
    # completes while that same client has a read pending.
    [switch] $Mute
)

$ErrorActionPreference = 'Stop'

$logPath = "$ReadyPath.log"
function Write-Log {
    param([string] $Message)
    Add-Content -Path $logPath -Value ((Get-Date).ToString('HH:mm:ss.fff') + ' ' + $Message)
}
Write-Log "started for pipe $PipeName"

function Read-Frame {
    param($Stream)
    $header = New-Object byte[] 4
    $filled = 0
    while ($filled -lt 4) {
        $read = $Stream.Read($header, $filled, 4 - $filled)
        if ($read -eq 0) { return $null }
        $filled += $read
    }
    $length = [System.BitConverter]::ToUInt32($header, 0)
    $body = New-Object byte[] $length
    $filled = 0
    while ($filled -lt $length) {
        $read = $Stream.Read($body, $filled, $length - $filled)
        if ($read -eq 0) { return $null }
        $filled += $read
    }
    return [System.Text.Encoding]::UTF8.GetString($body)
}

function Write-Frame {
    param($Stream, [string] $Json)
    $body = [System.Text.Encoding]::UTF8.GetBytes($Json)
    # BitConverter is little-endian on every platform Rhino runs on; the real
    # bridge must not rely on that silently, so it is asserted rather than
    # assumed.
    if (-not [System.BitConverter]::IsLittleEndian) { throw 'big-endian host' }
    $Stream.Write([System.BitConverter]::GetBytes([uint32] $body.Length), 0, 4)
    $Stream.Write($body, 0, $body.Length)
    $Stream.Flush()
}

$handshake = (Get-Content -Raw -Path $HandshakePath).Trim()
$eventJson = (Get-Content -Raw -Path $EventPath).Trim()
$template = (Get-Content -Raw -Path $ResponseTemplatePath).Trim()

$server = New-Object System.IO.Pipes.NamedPipeServerStream(
    $PipeName,
    [System.IO.Pipes.PipeDirection]::InOut,
    1,
    [System.IO.Pipes.PipeTransmissionMode]::Byte,
    [System.IO.Pipes.PipeOptions]::None)

# Only once the pipe exists is it safe for the client to try to open it.
Set-Content -Path $ReadyPath -Value 'ready' -NoNewline

try {
    $server.WaitForConnection()
    Write-Log 'client connected'

    while ($true) {
        $message = Read-Frame -Stream $server
        if ($null -eq $message) { Write-Log 'end of stream'; break }
        Write-Log "received $message"
        Write-Log ("message type is " + $message.GetType().FullName)

        if ($message -match '"envelope"\s*:\s*"handshake"') {
            Write-Frame -Stream $server -Json $handshake
            Write-Log 'handshake sent'
            continue
        }

        if ($message -match '"request_id"\s*:\s*"([^"]+)"') {
            $requestId = $Matches[1]
            if ($Mute) {
                Write-Log "swallowed $requestId"
                continue
            }
            # An event first, on purpose: the response must still find its way
            # to the caller that is waiting for it.
            Write-Frame -Stream $server -Json $eventJson
            Write-Frame -Stream $server -Json $template.Replace('__REQUEST_ID__', $requestId)
            Write-Log "answered $requestId"
            continue
        }

        Write-Log 'unrecognised message; closing'
        break
    }
}
catch {
    Write-Log ('ERROR ' + $_.Exception.GetType().FullName + ' :: ' + $_.Exception.Message)
    throw
}
finally {
    $server.Dispose()
}
