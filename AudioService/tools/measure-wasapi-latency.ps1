param(
    [string[]]$OutputDeviceIds = @(),
    [string]$InputDeviceId = '',
    [int]$QualificationSeconds = 15,
    [int]$FinalSeconds = 90,
    [string]$ServicePath = (Join-Path $PSScriptRoot '../build/Release/AudioService.exe'),
    [string]$ControlPath = (Join-Path $PSScriptRoot '../build/Release/AudioControl.exe'),
    [string]$EvidenceDirectory = (Join-Path $PSScriptRoot '../../../artifacts/local-latency'),
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

function Read-Diagnostics([string[]]$Lines) {
    $values = @{}
    foreach ($line in $Lines) {
        if ($line -match '^(?:0\|)?([^:\r\n]+):\s*(.*)$') {
            $values[$matches[1]] = $matches[2].Trim()
        }
    }
    return $values
}

function Read-Number($Values, [string]$Name) {
    $value = 0.0
    if ($Values.ContainsKey($Name)) {
        [void][double]::TryParse($Values[$Name], [Globalization.NumberStyles]::Float,
            [Globalization.CultureInfo]::InvariantCulture, [ref]$value)
    }
    return $value
}

function Test-SoftwareStability($Before, $After) {
    foreach ($key in @('XRuns', 'DeadlineMisses', 'RenderStarvedFrames', 'CaptureDiscontinuities')) {
        if ((Read-Number $After $key) -gt (Read-Number $Before $key)) { return $false }
    }
    $rate = Read-Number $After 'RuntimeOutputSampleRate'
    $periodFrames = Read-Number $After 'RuntimeOutputPeriodFrames'
    if ($rate -le 0 -or $periodFrames -le 0 -or
        (Read-Number $After 'RenderEventGapSamples') -le 0) { return $false }
    $periodMs = 1000 * $periodFrames / $rate
    $latencyMs = Read-Number $After 'LocalEstimatedMonitoringMs'
    if ($latencyMs -le 0 -or
        $latencyMs - (Read-Number $Before 'LocalEstimatedMonitoringMs') -gt $periodMs) {
        return $false
    }
    if ((Read-Number $After 'RenderEventGapP99Us') -gt 2000 * $periodMs -or
        (Read-Number $After 'PresentationJumpMaxNs') -gt 2000000 * $periodMs) {
        return $false
    }
    return $true
}

function Test-FinalConsistency([double]$QualificationMs, [double]$FinalMs,
                                [double]$PeriodFrames, [double]$RateHz) {
    if ($RateHz -le 0 -or $QualificationMs -le 0 -or $FinalMs -le 0) { return $false }
    return $FinalMs -le $QualificationMs + 1000 * $PeriodFrames / $RateHz
}

function Select-Finalists($Rows) {
    return @($Rows | Where-Object { $_.softwareStable } |
        Group-Object { "$($_.outputId)|$($_.mode)" } | ForEach-Object {
            $_.Group | Sort-Object estimatedMs | Select-Object -First 2
        })
}

function Get-PeriodCandidates($Capabilities, [string]$Mode) {
    $listed = @($Capabilities.periodFrames -split ',' | Where-Object { $_ } | ForEach-Object { [int]$_ })
    if ($Mode -eq 'shared') { return @($listed | Sort-Object -Unique) }
    $minimum = [int]$Capabilities.minPeriodFrames
    $maximum = [int]$Capabilities.maxPeriodFrames
    $step = [math]::Max(1, [int]$Capabilities.fundamentalPeriodFrames)
    if ($minimum -le 0 -or $maximum -lt $minimum) { return @() }
    $periods = @($minimum)
    $next = $minimum
    while ($next -lt $maximum) {
        $doubled = [math]::Min($maximum, 2 * $next)
        $aligned = $minimum + [math]::Ceiling(($doubled - $minimum) / $step) * $step
        if ($aligned -gt $maximum -or $aligned -le $next) { break }
        $periods += [int]$aligned
        $next = [int]$aligned
    }
    $periods += $listed
    return @($periods | Sort-Object -Unique)
}

if ($SelfTest) {
    $before = @{ XRuns = '0'; DeadlineMisses = '0'; RenderStarvedFrames = '0'; CaptureDiscontinuities = '0'; LocalEstimatedMonitoringMs = '12.5' }
    $after = @{ XRuns = '0'; DeadlineMisses = '0'; RenderStarvedFrames = '0'; CaptureDiscontinuities = '0'; LocalEstimatedMonitoringMs = '12.5'; RuntimeOutputPeriodFrames = '480'; RuntimeOutputSampleRate = '48000'; RenderEventGapSamples = '256'; RenderEventGapP99Us = '15000'; PresentationJumpMaxNs = '15000000' }
    if (-not (Test-SoftwareStability $before $after)) { throw 'stable candidate rejected' }
    $after.RenderEventGapSamples = '0'
    if (Test-SoftwareStability $before $after) { throw 'candidate without event measurements accepted' }
    $after.RenderEventGapSamples = '256'
    $after.RenderStarvedFrames = '1'
    if (Test-SoftwareStability $before $after) { throw 'starved candidate accepted' }
    $after.RenderStarvedFrames = '0'
    $after.LocalEstimatedMonitoringMs = '35'
    if (Test-SoftwareStability $before $after) { throw 'growing latency accepted' }
    $after.LocalEstimatedMonitoringMs = '12.5'
    $after.RenderEventGapP99Us = '25000'
    if (Test-SoftwareStability $before $after) { throw 'missed render cadence accepted' }
    $rows = @(
        [pscustomobject]@{ outputId = 'a'; mode = 'shared'; softwareStable = $true; estimatedMs = 12.5 },
        [pscustomobject]@{ outputId = 'a'; mode = 'shared'; softwareStable = $true; estimatedMs = 9.0 },
        [pscustomobject]@{ outputId = 'a'; mode = 'shared'; softwareStable = $true; estimatedMs = 15.0 },
        [pscustomobject]@{ outputId = 'a'; mode = 'exclusive'; softwareStable = $false; estimatedMs = 3.0 }
    )
    $chosen = @(Select-Finalists $rows)
    if ($chosen.Count -ne 2 -or $chosen[0].estimatedMs -ne 9.0 -or
        $chosen[1].estimatedMs -ne 12.5) { throw 'finalists are not the two fastest stable candidates' }
    $periods = @(Get-PeriodCandidates @{ periodFrames = '133,441'; minPeriodFrames = '133'; maxPeriodFrames = '441'; fundamentalPeriodFrames = '1' } 'exclusive')
    if ($periods.Count -ne 3 -or $periods[0] -ne 133 -or $periods[1] -ne 266 -or
        $periods[2] -ne 441) { throw 'exclusive candidates are not derived from endpoint bounds' }
    if (-not (Test-FinalConsistency 9.0 9.4 133 44100) -or
        (Test-FinalConsistency 28.0 69.0 441 44100)) {
        throw 'final latency is not compared with its qualification baseline'
    }
    Write-Output 'WASAPI sweep selection tests passed'
    exit 0
}

if ($QualificationSeconds -lt 10 -or $FinalSeconds -lt 60) {
    throw 'QualificationSeconds must be at least 10 and FinalSeconds at least 60.'
}
foreach ($path in @($ServicePath, $ControlPath)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing executable: $path" }
}

$runDirectory = Join-Path $EvidenceDirectory (Get-Date -Format 'yyyy-MM-dd-HHmmss')
New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null
$oldEndpoint = $env:AD_VOICE_AUDIO_ENDPOINT
$probe = $null

function Invoke-Control([string[]]$Arguments) {
    $lines = @(& $ControlPath @Arguments)
    if ($LASTEXITCODE -ne 0 -or $lines.Count -eq 0 -or -not $lines[0].StartsWith('0|')) {
        throw "AudioControl $($Arguments[0]) failed: $($lines -join ' ')"
    }
    return $lines
}

function Start-Probe {
    $env:AD_VOICE_AUDIO_ENDPOINT = "\\.\pipe\ADVoice.WasapiSweep.$([guid]::NewGuid().ToString('N'))"
    $script:probe = Start-Process -FilePath $ServicePath -WindowStyle Hidden -PassThru
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 100
        try { [void](Invoke-Control @('GetServiceState')); return } catch { }
    }
    throw 'AudioService did not expose its isolated control pipe.'
}

function Stop-Probe {
    if ($script:probe) {
        try { [void](Invoke-Control @('ShutdownService')) } catch { }
        if (-not $script:probe.WaitForExit(3000)) {
            Stop-Process -Id $script:probe.Id -Force
            [void]$script:probe.WaitForExit(3000)
        }
        $script:probe.Dispose()
        $script:probe = $null
    }
}

function Invoke-Candidate($Candidate, [int]$Seconds, [string]$Stage,
                          [double]$QualificationMs = 0) {
    $row = [ordered]@{
        outputId = $Candidate.outputId; mode = $Candidate.mode; rateHz = $Candidate.rateHz
        periodFrames = $Candidate.periodFrames; stage = $Stage; durationSeconds = $Seconds
        softwareStable = $false; estimatedMs = 0; error = ''; diagnostics = @{}
    }
    try {
        Start-Probe
        $arguments = @('PrepareSession', "backend=wasapi-$($Candidate.mode)",
            "rate=$($Candidate.rateHz)", "period=$($Candidate.periodFrames)",
            "output=$($Candidate.outputId)")
        if ($InputDeviceId) { $arguments += "input=$InputDeviceId" }
        [void](Invoke-Control $arguments)
        [void](Invoke-Control @('StartSession'))
        Start-Sleep -Seconds 2
        $before = Read-Diagnostics (Invoke-Control @('GetDiagnostics'))
        Start-Sleep -Seconds $Seconds
        $after = Read-Diagnostics (Invoke-Control @('GetDiagnostics'))
        $row.softwareStable = Test-SoftwareStability $before $after
        $row.estimatedMs = Read-Number $after 'LocalEstimatedMonitoringMs'
        if ($Stage -eq 'final') {
            $row.softwareStable = $row.softwareStable -and (Test-FinalConsistency $QualificationMs $row.estimatedMs $Candidate.periodFrames $Candidate.rateHz)
        }
        $row.diagnostics = $after
        $row.before = $before
    } catch {
        $row.error = $_.Exception.Message
    } finally {
        Stop-Probe
    }
    $name = "$Stage-$($Candidate.mode)-$($Candidate.rateHz)-$($Candidate.periodFrames)-$($Candidate.index).json"
    [pscustomobject]$row | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runDirectory $name)
    return [pscustomobject]$row
}

try {
    Start-Probe
    $devices = @(Invoke-Control @('GetDevices')) | ForEach-Object {
        if ($_ -match '^(?:0\|)?(\{[^,]+\}),(.+),1,1,\d+$') {
            [pscustomobject]@{ id = $matches[1]; name = $matches[2] }
        }
    }
    if ($OutputDeviceIds.Count -gt 0) {
        $devices = @($devices | Where-Object { $OutputDeviceIds -contains $_.id })
    }
    if ($devices.Count -eq 0) { throw 'No matching WASAPI output endpoint was enumerated.' }
    $candidates = @()
    $index = 0
    foreach ($device in $devices) {
        foreach ($mode in @('shared', 'exclusive')) {
            foreach ($rate in @(44100, 48000, 96000)) {
                try {
                    $arguments = @('GetAudioCapabilities', "backend=wasapi-$mode",
                        "rate=$rate", "output=$($device.id)")
                    if ($InputDeviceId) { $arguments += "input=$InputDeviceId" }
                    $caps = @{}
                    foreach ($line in (Invoke-Control $arguments)) {
                        if ($line -match '^(?:0\|)?([^=\r\n]+)=(.*)$') {
                            $caps[$matches[1]] = $matches[2]
                        }
                    }
                    if (@($caps.sampleRatesHz -split ',') -notcontains [string]$rate) { continue }
                    foreach ($period in @(Get-PeriodCandidates $caps $mode)) {
                        $index++
                        $candidates += [pscustomobject]@{
                            outputId = $device.id; name = $device.name; mode = $mode
                            rateHz = $rate; periodFrames = [int]$period; index = $index
                        }
                    }
                } catch {
                    # A busy or unsupported endpoint is recorded by its missing candidate.
                }
            }
        }
    }
    Stop-Probe
    $qualifications = @($candidates | ForEach-Object {
        Invoke-Candidate $_ $QualificationSeconds 'qualification'
    })
    $finalists = @(Select-Finalists $qualifications)
    $finals = @($finalists | ForEach-Object {
        $row = $_
        $candidate = $candidates | Where-Object {
            $_.outputId -eq $row.outputId -and $_.mode -eq $row.mode -and
            $_.rateHz -eq $row.rateHz -and $_.periodFrames -eq $row.periodFrames
        } | Select-Object -First 1
        Invoke-Candidate $candidate $FinalSeconds 'final' $row.estimatedMs
    })
    [pscustomobject]@{
        generatedAt = (Get-Date).ToString('o'); inputDeviceId = $InputDeviceId
        endpoints = $devices; qualifications = $qualifications; finals = $finals
        note = 'Software counters only; clicks, PCM continuity, and physical latency require loopback verification.'
    } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $runDirectory 'summary.json')
    Write-Output $runDirectory
} finally {
    Stop-Probe
    $env:AD_VOICE_AUDIO_ENDPOINT = $oldEndpoint
}
