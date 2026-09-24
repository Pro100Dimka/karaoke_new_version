[CmdletBinding()]
param(
    [string]$HostName = "130.61.169.61",
    [string]$RemoteUser = "ubuntu",
    [string]$KeyPath = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$KeyPath = if ($KeyPath) {
    $KeyPath
} else {
    Join-Path $projectRoot "local-secrets\ssh\karaoke_room_server"
}
$knownHostsPath = Join-Path $projectRoot "local-secrets\ssh\known_hosts"
$pythonRoot = Join-Path $projectRoot "python"
$python = Join-Path $pythonRoot ".venv\Scripts\python.exe"
$remoteDeployScript = Join-Path $PSScriptRoot "deploy-room-server.sh"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$archiveName = "karaoke-room-server-$stamp.tar.gz"
$archive = Join-Path ([IO.Path]::GetTempPath()) $archiveName
$remoteArchive = "/tmp/$archiveName"
$remoteScript = "/tmp/deploy-room-server-$stamp.sh"
$destination = "${RemoteUser}@${HostName}"

if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) {
    throw "SSH key was not found: $KeyPath"
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
    Write-Host "Checking Room Server tests..."
    & $python -m pytest (Join-Path $pythonRoot "tests\test_room_server.py") -q
    if ($LASTEXITCODE -ne 0) { throw "Room Server tests failed" }

    Write-Host "Packaging Room Server..."
    & tar.exe -czf $archive --exclude=__pycache__ --exclude=*.pyc -C $pythonRoot backend pyproject.toml
    if ($LASTEXITCODE -ne 0) { throw "Could not create Room Server package" }

    Write-Host "Uploading to $HostName..."
    & scp -i $KeyPath -o BatchMode=yes -o "UserKnownHostsFile=$knownHostsPath" $archive "${destination}:$remoteArchive"
    if ($LASTEXITCODE -ne 0) { throw "Could not upload Room Server package" }
    & scp -i $KeyPath -o BatchMode=yes -o "UserKnownHostsFile=$knownHostsPath" $remoteDeployScript "${destination}:$remoteScript"
    if ($LASTEXITCODE -ne 0) { throw "Could not upload deployment script" }

    Write-Host "Activating the new version..."
    & ssh -i $KeyPath -o BatchMode=yes -o "UserKnownHostsFile=$knownHostsPath" $destination "chmod 700 '$remoteScript' && '$remoteScript' '$stamp' '$remoteArchive'"
    if ($LASTEXITCODE -ne 0) { throw "Room Server deployment failed; the previous version was restored" }

    Write-Host "Room Server was updated successfully."
}
finally {
    if (Test-Path -LiteralPath $archive) {
        Remove-Item -LiteralPath $archive -Force
    }
}
