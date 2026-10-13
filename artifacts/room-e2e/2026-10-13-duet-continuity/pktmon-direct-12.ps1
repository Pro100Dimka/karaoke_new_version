$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$added = $false
$started = $false
try {
    $filters = pktmon filter list 2>&1
    $filters | Out-File "$root/direct12-filters-before.txt"
    if ($LASTEXITCODE -ne 0 -or ($filters -match '^\s*\d+\s')) { throw 'Cannot prove empty filter list' }
    pktmon filter add ADVoiceDirect12 -i 192.168.0.194 -t UDP | Out-File "$root/direct12-start.txt"
    if ($LASTEXITCODE -ne 0) { throw 'Filter failed' }
    $added = $true
    pktmon start --capture --comp all --pkt-size 128 --file-name "$root/direct12.etl" --file-size 64 | Out-File "$root/direct12-start.txt" -Append
    if ($LASTEXITCODE -ne 0) { throw 'Capture failed' }
    $started = $true
    [DateTime]::UtcNow.ToString('o') | Set-Content "$root/direct12-ready.txt"
    Start-Sleep -Seconds 50
} catch { $_ | Out-File "$root/direct12-error.txt" }
finally {
    if ($started) { pktmon stop | Out-File "$root/direct12-stop.txt" }
    if ($added) { pktmon filter remove ADVoiceDirect12 | Out-File "$root/direct12-cleanup.txt" }
}
if ($started) { pktmon etl2pcap "$root/direct12.etl" --out "$root/direct12.pcapng" | Out-File "$root/direct12-convert.txt" }
