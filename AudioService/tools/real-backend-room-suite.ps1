# Runs each real Windows backend in an isolated AudioService/relay lifecycle so a previous device
# generation cannot make the next backend look healthy or unhealthy. Hardware/driver failures are
# intentional gate failures, not simulated skips.
param([string]$Output = "artifacts/room-e2e/real-windows-backends")
$root = Resolve-Path "$PSScriptRoot\..\.."
$gate = "$PSScriptRoot\real-backend-room-gate.mjs"
$failed = $false
foreach ($backend in @("wasapi-shared", "wasapi-exclusive", "asio")) {
    & node $gate "$root\$Output\$backend" --require $backend
    if ($LASTEXITCODE -ne 0) { $failed = $true }
}
if ($failed) { exit 1 }
