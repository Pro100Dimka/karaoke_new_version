# Runs room-sync-probe in the standard configurations and prints the measured lags.
#   loopback / acoustic  x  aligned recording (performance) / heard by the listener (master)
# Usage: room-sync-suite.ps1 <label> [extra probe args...]
param([Parameter(Mandatory = $true)][string]$Label, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Extra)
$root = Resolve-Path "$PSScriptRoot\..\.."
$probe = "$root\AudioService\tools\room-sync-probe.mjs"
$analyze = "$root\AudioService\tools\room-sync-analyze.py"
$python = "$root\python\.venv\Scripts\python.exe"
$markers = "$root\artifacts\room-sync\markers"
if (-not (Test-Path "$markers\instrumental.wav")) { & $python "$root\AudioService\tools\room-sync-markers.py" $markers 120 | Out-Null }
$configs = @(
    @{ Name = "loopback-aligned"; Args = @() },
    @{ Name = "loopback-heard"; Args = @("--heard") },
    @{ Name = "acoustic-aligned"; Args = @("--acoustic") },
    @{ Name = "acoustic-heard"; Args = @("--acoustic", "--heard") }
)
foreach ($config in $configs) {
    $out = "$root\artifacts\room-sync\$Label-$($config.Name)"
    $arguments = @($probe, $out, "--seconds", "16", "--song", $markers) + $config.Args + $Extra
    & node @arguments 2>&1 | Select-String "failed"
    $result = & $python $analyze $out $markers 30 | ConvertFrom-Json
    $report = Get-Content "$out\report.json" -Raw | ConvertFrom-Json
    $b = $report.samples[-1][1]
    "{0,-18} own voice {1,6} ms | remote voice {2,6} ms | B room delay {3} frames" -f $config.Name, $result.A.medianLagMs, $result.B.medianLagMs, $b.roomCompensationFrames
}
