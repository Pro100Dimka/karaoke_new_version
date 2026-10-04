[CmdletBinding()]
param(
    [string]$HostName = "",
    [string]$RemoteUser = "",
    [string]$KeyPath = "",
    [string]$KnownHostsPath = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

function Read-DotEnvValue {
    param([string]$Path, [string]$Name)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "" }
    $escapedName = [Regex]::Escape($Name)
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match "^\s*$escapedName\s*=\s*(.*)$") {
            return $Matches[1].Trim().Trim('"').Trim("'")
        }
    }
    return ""
}

function Resolve-ProjectPath {
    param([string]$Value, [string]$Fallback)
    $selected = if ($Value) { $Value } else { $Fallback }
    if ([IO.Path]::IsPathRooted($selected)) { return [IO.Path]::GetFullPath($selected) }
    return [IO.Path]::GetFullPath((Join-Path $projectRoot $selected))
}

$projectEnv = Join-Path $projectRoot "local-secrets\env\project.env"
$frontendEnv = Join-Path $projectRoot "frontend\.env.local"
$HostName = if ($HostName) { $HostName } else { Read-DotEnvValue $frontendEnv "AD_VOICE_ROOM_SERVER_HOST" }
if (-not $HostName) { $HostName = Read-DotEnvValue $projectEnv "AD_VOICE_ROOM_SERVER_HOST" }
if (-not $HostName) {
    $serverUrl = Read-DotEnvValue $frontendEnv "AD_VOICE_ROOM_SERVER"
    if (-not $serverUrl) { $serverUrl = Read-DotEnvValue $projectEnv "AD_VOICE_ROOM_SERVER" }
    if ($serverUrl) { $HostName = ([Uri]$serverUrl).Host }
}
if (-not $HostName) { throw "Room Server host is not configured" }
$RemoteUser = if ($RemoteUser) { $RemoteUser } else { Read-DotEnvValue $projectEnv "AD_VOICE_ROOM_SERVER_SSH_USER" }
if (-not $RemoteUser) { $RemoteUser = "ubuntu" }
$configuredKey = Read-DotEnvValue $projectEnv "AD_VOICE_ROOM_SERVER_SSH_KEY"
if (-not $configuredKey) { $configuredKey = "local-secrets\ssh\karaoke_room_server" }
$KeyPath = Resolve-ProjectPath $KeyPath $configuredKey
$configuredKnownHosts = Read-DotEnvValue $projectEnv "AD_VOICE_ROOM_SERVER_KNOWN_HOSTS"
if (-not $configuredKnownHosts) { $configuredKnownHosts = "local-secrets\ssh\known_hosts" }
$KnownHostsPath = Resolve-ProjectPath $KnownHostsPath $configuredKnownHosts
$pythonRoot = Join-Path $projectRoot "python"
$python = Join-Path $pythonRoot ".venv\Scripts\python.exe"
$remoteDeployScript = Join-Path $PSScriptRoot "deploy-room-server.sh"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$archiveName = "karaoke-room-server-$stamp.tar.gz"
$archive = Join-Path ([IO.Path]::GetTempPath()) $archiveName
$normalizedDeployScript = Join-Path ([IO.Path]::GetTempPath()) "deploy-room-server-$stamp.sh"
$remoteArchive = "/tmp/$archiveName"
$remoteScript = "/tmp/deploy-room-server-$stamp.sh"
$destination = "${RemoteUser}@${HostName}"

if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) {
    throw "SSH key was not found: $KeyPath"
}
if (-not (Test-Path -LiteralPath $KnownHostsPath -PathType Leaf)) {
    throw "known_hosts was not found: $KnownHostsPath"
}
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "Python environment was not found: $python"
}

# A key moved into the workspace inherits its ACL; OpenSSH rejects access granted to other users.
& icacls.exe $KeyPath /inheritance:r | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not disable inherited permissions for SSH key" }
& icacls.exe $KeyPath /grant:r "$($env:USERNAME):(R)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not restrict SSH key permissions" }

try {
    $deployScript = (Get-Content -LiteralPath $remoteDeployScript -Raw).Replace("`r`n", "`n")
    [IO.File]::WriteAllText($normalizedDeployScript, $deployScript, [Text.UTF8Encoding]::new($false))

    Write-Host "Checking Room Server tests..."
    & $python -m pytest `
        (Join-Path $pythonRoot "tests\test_room_server.py") `
        (Join-Path $pythonRoot "tests\test_voice_relay.py") `
        (Join-Path $pythonRoot "tests\test_native_voice_relay.py") `
        -q
    if ($LASTEXITCODE -ne 0) { throw "Room Server tests failed" }

    Write-Host "Packaging Room Server..."
    & tar.exe -czf $archive --exclude=__pycache__ --exclude=*.pyc `
        -C $pythonRoot backend pyproject.toml `
        -C $projectRoot AudioService/src/relay AudioService/src/network/NetworkPacket.hpp
    if ($LASTEXITCODE -ne 0) { throw "Could not create Room Server package" }

    Write-Host "Uploading to $HostName..."
    & scp -i $KeyPath -o BatchMode=yes -o "IPQoS=none" -o "UserKnownHostsFile=$knownHostsPath" $archive "${destination}:$remoteArchive"
    if ($LASTEXITCODE -ne 0) { throw "Could not upload Room Server package" }
    & scp -i $KeyPath -o BatchMode=yes -o "IPQoS=none" -o "UserKnownHostsFile=$knownHostsPath" $normalizedDeployScript "${destination}:$remoteScript"
    if ($LASTEXITCODE -ne 0) { throw "Could not upload deployment script" }

    Write-Host "Activating the new version..."
    & ssh -i $KeyPath -o BatchMode=yes -o "IPQoS=none" -o "UserKnownHostsFile=$knownHostsPath" $destination "chmod 700 '$remoteScript' && '$remoteScript' '$stamp' '$remoteArchive'"
    if ($LASTEXITCODE -ne 0) { throw "Room Server deployment failed; the previous version was restored" }

    Write-Host "Room Server was updated successfully."
}
finally {
    if (Test-Path -LiteralPath $archive) {
        Remove-Item -LiteralPath $archive -Force
    }
    if (Test-Path -LiteralPath $normalizedDeployScript) {
        Remove-Item -LiteralPath $normalizedDeployScript -Force
    }
}
