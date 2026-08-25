<#
.SYNOPSIS
    Build HII Rhino and register it with Rhino 8 for this user.

.DESCRIPTION
    Builds the plug-in, then registers it by handing the .rhp to Rhino as a file
    argument, which is exactly what dragging it onto the Rhino window does.

    Rhino writes the registration itself, including the RegPath value and the
    CommandList that lets it load the plug-in on demand. Writing those entries by
    hand does not work: a registration missing them is ignored at startup with no
    diagnostic, which is a slow thing to discover.

    The registration points straight at the build output, so a rebuild is picked
    up by the next Rhino start with no reinstall. That is what makes this a
    development install rather than something to ship; real distribution is a Yak
    package, which is not part of checkpoint C.

    Rhino reads plug-in registration at startup, so an already-running Rhino will
    not see a newly registered plug-in until it is restarted.

.PARAMETER Configuration
    Debug (default) or Release.

.PARAMETER Uninstall
    Remove the registration instead of adding it.
#>
[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string] $Configuration = 'Debug',
    [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'

# Must match the assembly GuidAttribute in src/HiiRhino.Plugin/AssemblyInfo.cs.
# Rhino keys everything about the plug-in on this value.
$PlugInId = '505247d9-781c-43b6-8734-22276e9ed78c'
$PlugInName = 'HII Rhino'
$TargetFramework = 'net7.0-windows'

$root = Split-Path -Parent $PSScriptRoot
$project = Join-Path $root 'src/HiiRhino.Plugin/HiiRhino.Plugin.csproj'
$registryKey = "HKCU:\Software\McNeel\Rhinoceros\8.0\Plug-Ins\$PlugInId"

if ($Uninstall) {
    if (Test-Path $registryKey) {
        Remove-Item $registryKey -Recurse -Force
        Write-Host "Unregistered $PlugInName."
    }
    else {
        Write-Host "$PlugInName was not registered."
    }
    return
}

Write-Host "Building $PlugInName ($Configuration)..."
& dotnet build $project -c $Configuration -v minimal --nologo
if ($LASTEXITCODE -ne 0) {
    throw "the build failed with exit code $LASTEXITCODE"
}

$rhp = Join-Path $root "src/HiiRhino.Plugin/bin/$Configuration/$TargetFramework/HiiRhino.rhp"
if (-not (Test-Path $rhp)) {
    throw "the build produced no plug-in at $rhp"
}
$rhp = (Resolve-Path $rhp).Path

$registered = (Test-Path "$registryKey\PlugIn") -and
    ((Get-ItemProperty "$registryKey\PlugIn").FileName -eq $rhp)

if ($registered) {
    Write-Host "Already registered -> $rhp"
}
else {
    $rhino = 'C:\Program Files\Rhino 8\System\Rhino.exe'
    if (-not (Test-Path $rhino)) {
        throw "Rhino 8 was not found at $rhino"
    }

    Write-Host 'Registering with Rhino (a Rhino window will open; close it when it appears)...'
    $process = Start-Process -FilePath $rhino -ArgumentList '/nosplash', "`"$rhp`"" -PassThru

    $deadline = (Get-Date).AddMinutes(3)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        if ((Test-Path "$registryKey\PlugIn") -and
            ((Get-ItemProperty "$registryKey\PlugIn").FileName -eq $rhp)) {
            $registered = $true
            break
        }
        if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
            break
        }
    }

    if (-not $registered) {
        throw "Rhino did not register the plug-in. Drag $rhp onto a running Rhino window instead."
    }

    Write-Host "Registered $PlugInName -> $rhp"
}

# Rhino sets LoadMode 2 (load on demand) itself. That is what we want, and it is
# deliberately not the same as starting the bridge: running StartHiiRhinoBridge
# loads the plug-in, and only that command opens a pipe.
Write-Host ''
Write-Host 'In Rhino, run:  StartHiiRhinoBridge'
Write-Host 'and to stop it: StopHiiRhinoBridge'
