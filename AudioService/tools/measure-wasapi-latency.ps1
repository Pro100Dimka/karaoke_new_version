param(
    [string[]]$OutputDeviceIds = @(),
    [string]$InputDeviceId = '',
    [string[]]$InputDeviceIds = @(),
    [switch]$CompareShared,
    [int]$MeasurementSeconds = 30,
    [int[]]$SampleRatesHz = @(),
    [switch]$Zip,
    [int]$QualificationSeconds = 15,
    [int]$FinalSeconds = 90,
    [string]$ServicePath = (Join-Path $PSScriptRoot '../build/Release/AudioService.exe'),
    [string]$ControlPath = (Join-Path $PSScriptRoot '../build/Release/AudioControl.exe'),
    [string]$EvidenceDirectory = (Join-Path $PSScriptRoot '../../artifacts/local-latency'),
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

function Select-DevicePairs($Devices, [string[]]$Inputs, [string[]]$Outputs) {
    $inputDevices = @($Devices | Where-Object {
        $_.direction -eq 'input' -and ($Inputs.Count -eq 0 -or $Inputs -contains $_.id)
    })
    $outputDevices = @($Devices | Where-Object {
        $_.direction -eq 'output' -and ($Outputs.Count -eq 0 -or $Outputs -contains $_.id)
    })
    foreach ($inputDevice in $inputDevices) {
        foreach ($outputDevice in $outputDevices) {
            [pscustomobject]@{
                inputId = $inputDevice.id; inputName = $inputDevice.name
                outputId = $outputDevice.id; outputName = $outputDevice.name
            }
        }
    }
}

function Expand-DeviceIds([string[]]$Values) {
    return @($Values | ForEach-Object { $_ -split '[,;]' } | ForEach-Object { $_.Trim() } |
        Where-Object { $_ })
}

function Get-LatencyBreakdown($Diagnostics) {
    $capture = Read-Number $Diagnostics 'LocalCaptureDeviceMs'
    $internal = (Read-Number $Diagnostics 'LocalAudioServiceInternalMs') +
        (Read-Number $Diagnostics 'LocalResamplerDspMs')
    $queue = Read-Number $Diagnostics 'LocalRenderQueueMs'
    $output = Read-Number $Diagnostics 'LocalEndpointOutputMs'
    $total = Read-Number $Diagnostics 'LocalEstimatedMonitoringMs'
    $actual = Read-Number $Diagnostics 'SharedEnginePeriodActualFrames'
    $minimum = Read-Number $Diagnostics 'SharedEnginePeriodMinimumFrames'
    $rate = Read-Number $Diagnostics 'RuntimeOutputSampleRate'
    $periodMs = if ($rate -gt 0) { 1000 * $actual / $rate } else { 0 }
    $causes = @()
    if ($capture -ge 15) { $causes += 'CAPTURE_PERIOD_HIGH' }
    if ($periodMs -ge 15) { $causes += 'RENDER_PERIOD_HIGH' }
    if ($minimum -gt 0 -and $rate -gt 0 -and 1000 * $minimum / $rate -ge 15) {
        $causes += 'ENGINE_PERIOD_MINIMUM_HIGH'
    }
    if ($minimum -gt 0 -and $actual -gt $minimum) { $causes += 'ENGINE_PERIOD_NOT_MINIMUM' }
    if ($Diagnostics.SharedEnginePeriodFallback -eq 'ENGINE_PERIODICITY_LOCKED') {
        $causes += 'ENGINE_PERIOD_LOCKED'
    }
    if ($periodMs -gt 0 -and $queue -gt 1.5 * $periodMs) { $causes += 'AUDIOSERVICE_QUEUE_HIGH' }
    if ($rate -gt 0 -and (Read-Number $Diagnostics 'RenderPaddingP95Frames') * 1000 / $rate -gt 1.5 * $periodMs) {
        $causes += 'PADDING_HIGH'
    }
    if ((Read-Number $Diagnostics 'RenderStarvedFrames') -gt 0) { $causes += 'STARVATION_SAFETY_MARGIN' }
    if ((Read-Number $Diagnostics 'DuplexWaitP95Us') -ge 2000) { $causes += 'DUPLEX_WAIT_HIGH' }
    if ((Read-Number $Diagnostics 'RuntimeInputSampleRate') -ne $rate) { $causes += 'RESAMPLING_BOUNDARY' }
    if ($Diagnostics.SharedEnginePeriodFallback -notin @('', 'NONE', 'ENGINE_PERIODICITY_LOCKED')) {
        $causes += 'FORMAT_NEGOTIATION_FALLBACK'
    }
    if ($causes.Count -eq 0) { $causes = @('UNKNOWN') }
    return [pscustomobject]@{
        captureMs = $capture; internalMs = $internal; renderQueueMs = $queue
        outputMs = $output; totalMs = $total; unaccountedMs = $total - $capture - $internal - $queue - $output
        causes = $causes
    }
}

function Get-ComparisonPeriods($Capabilities) {
    return @(@([int]$Capabilities.minPeriodFrames, [int]$Capabilities.defaultPeriodFrames) |
        Where-Object { $_ -gt 0 } | Sort-Object -Unique)
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
    $expectedEvidenceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../artifacts/local-latency'))
    if ([IO.Path]::GetFullPath($EvidenceDirectory) -ne $expectedEvidenceRoot) {
        throw 'default evidence directory must be inside the repository artifacts folder'
    }
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
    $devices = @(
        [pscustomobject]@{ id = 'mic-a'; name = 'Mic A'; direction = 'input' },
        [pscustomobject]@{ id = 'mic-b'; name = 'Mic B'; direction = 'input' },
        [pscustomobject]@{ id = 'speaker-a'; name = 'Speaker A'; direction = 'output' }
    )
    $pairs = @(Select-DevicePairs $devices @() @())
    if ($pairs.Count -ne 2 -or $pairs[0].inputId -ne 'mic-a' -or
        $pairs[1].inputId -ne 'mic-b' -or $pairs[0].outputId -ne 'speaker-a') {
        throw 'all available input/output pairs must be measurable'
    }
    $selected = @(Select-DevicePairs $devices @('mic-b') @('speaker-a'))
    if ($selected.Count -ne 1 -or $selected[0].inputId -ne 'mic-b') {
        throw 'selected input/output pair was not honored'
    }
    $comparisonPeriods = @(Get-ComparisonPeriods @{ minPeriodFrames = '128'; defaultPeriodFrames = '480' })
    if ($comparisonPeriods.Count -ne 2 -or $comparisonPeriods[0] -ne 128 -or
        $comparisonPeriods[1] -ne 480) {
        throw 'comparative measurement must include minimum and default Shared periods'
    }
    $ids = @(Expand-DeviceIds @('speaker-a,speaker-b'))
    if ($ids.Count -ne 2 -or $ids[0] -ne 'speaker-a' -or $ids[1] -ne 'speaker-b') {
        throw 'multiple endpoint IDs must be accepted from powershell.exe -File'
    }
    $budget = Get-LatencyBreakdown @{
        LocalCaptureDeviceMs = '20'; LocalAudioServiceInternalMs = '2'
        LocalResamplerDspMs = '0.4'; LocalRenderQueueMs = '20'
        LocalEndpointOutputMs = '29.6'; LocalEstimatedMonitoringMs = '72'
        RuntimeInputSampleRate = '48000'; RuntimeOutputSampleRate = '48000'
        RuntimeOutputPeriodFrames = '960'; SharedEnginePeriodMinimumFrames = '240'
        SharedEnginePeriodActualFrames = '960'; RenderPaddingP95Frames = '960'
        RenderStarvedFrames = '0'; SharedEnginePeriodFallback = 'NONE'
    }
    if ($budget.totalMs -ne 72 -or $budget.captureMs -ne 20 -or
        $budget.internalMs -ne 2.4 -or $budget.outputMs -ne 29.6 -or
        $budget.causes -notcontains 'ENGINE_PERIOD_NOT_MINIMUM' -or
        $budget.causes -contains 'WINDOWS_OR_DRIVER_LIMITED') {
        throw 'latency breakdown or multiple-cause classification is incorrect'
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
        inputId = $Candidate.inputId; inputName = $Candidate.inputName
        outputId = $Candidate.outputId; outputName = $Candidate.outputName
        mode = $Candidate.mode; rateHz = $Candidate.rateHz
        periodFrames = $Candidate.periodFrames; stage = $Stage; durationSeconds = $Seconds
        softwareStable = $false; estimatedMs = 0; error = ''; diagnostics = @{}
    }
    try {
        Start-Probe
        $arguments = @('PrepareSession', "backend=wasapi-$($Candidate.mode)",
            "rate=$($Candidate.rateHz)", "period=$($Candidate.periodFrames)",
            "output=$($Candidate.outputId)")
        $selectedInput = if ($Candidate.inputId) { $Candidate.inputId } else { $InputDeviceId }
        if ($selectedInput) { $arguments += "input=$selectedInput" }
        [void](Invoke-Control $arguments)
        [void](Invoke-Control @('StartSession'))
        Start-Sleep -Seconds 2
        $before = Read-Diagnostics (Invoke-Control @('GetDiagnostics'))
        Start-Sleep -Seconds $Seconds
        $after = Read-Diagnostics (Invoke-Control @('GetDiagnostics'))
        $row.softwareStable = Test-SoftwareStability $before $after
        $row.estimatedMs = Read-Number $after 'LocalEstimatedMonitoringMs'
        $row.breakdown = Get-LatencyBreakdown $after
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

if ($CompareShared) {
    if ($MeasurementSeconds -lt 30 -or $MeasurementSeconds -gt 60) {
        throw 'MeasurementSeconds must be between 30 and 60 for comparative Shared measurements.'
    }
    try {
        Start-Probe
        $devices = @(Invoke-Control @('GetDevices')) | ForEach-Object {
            if ($_ -match '^(?:0\|)?(\{[^,]+\}),(.*),1,([01]),\d+$') {
                [pscustomobject]@{
                    id = $matches[1]; name = $matches[2]
                    direction = if ($matches[3] -eq '0') { 'input' } else { 'output' }
                }
            }
        }
        $inputs = if ($InputDeviceIds.Count -gt 0) { @(Expand-DeviceIds $InputDeviceIds) } elseif ($InputDeviceId) { @($InputDeviceId) } else { @() }
        $outputs = @(Expand-DeviceIds $OutputDeviceIds)
        $pairs = @(Select-DevicePairs $devices $inputs $outputs)
        if ($pairs.Count -eq 0) { throw 'No matching WASAPI Shared input/output pair was enumerated.' }
        $candidates = @()
        $queryErrors = @()
        $index = 0
        foreach ($pair in $pairs) {
            try {
                $caps = @{}
                foreach ($line in (Invoke-Control @('GetAudioCapabilities', 'backend=wasapi-shared',
                            "input=$($pair.inputId)", "output=$($pair.outputId)", 'rate=0'))) {
                    if ($line -match '^(?:0\|)?([^=\r\n]+)=(.*)$') { $caps[$matches[1]] = $matches[2] }
                }
                $rates = if ($SampleRatesHz.Count -gt 0) { $SampleRatesHz } else { @([int]$caps.defaultSampleRateHz) }
                foreach ($rate in $rates) {
                    if (@($caps.sampleRatesHz -split ',') -notcontains [string]$rate) { continue }
                    foreach ($period in @(Get-ComparisonPeriods $caps)) {
                        $index++
                        $candidates += [pscustomobject]@{
                            inputId = $pair.inputId; inputName = $pair.inputName
                            outputId = $pair.outputId; outputName = $pair.outputName
                            mode = 'shared'; rateHz = $rate; periodFrames = $period
                            index = $index; capabilities = $caps
                        }
                    }
                }
            } catch {
                $queryErrors += [pscustomobject]@{ pair = $pair; error = $_.Exception.Message }
            }
        }
        Stop-Probe
        $rows = @($candidates | ForEach-Object {
            Invoke-Candidate $_ $MeasurementSeconds 'shared-comparison'
        })
        $summary = [pscustomobject]@{
            schemaVersion = 2; generatedAt = (Get-Date).ToString('o')
            method = 'isolated AudioService software estimate; no physical loopback'
            devices = $devices; pairs = $pairs; candidates = $candidates
            results = $rows; queryErrors = $queryErrors
        }
        $summary | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $runDirectory 'summary.json') -Encoding UTF8
        $report = @(
            '# WASAPI Shared endpoint comparison', ''
            "Generated: $($summary.generatedAt)", ''
            'Software estimates only. Physical input-to-output latency and PCM continuity require a loopback measurement.', ''
            '| Input | Output | Requested | Actual | Capture | Internal | Queue | Output residual | Total estimated | Padding P50/P95/P99 | XRuns / starvation | RAW in/out | IAudioClient3 | Causes |',
            '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |'
        )
        foreach ($row in $rows) {
            $d = $row.diagnostics
            $b = $row.breakdown
            $report += "| $($row.inputName) | $($row.outputName) | $($row.periodFrames) @ $($row.rateHz) | $($d.SharedEnginePeriodActualFrames) @ $($d.RuntimeOutputSampleRate) | $($b.captureMs) | $($b.internalMs) | $($b.renderQueueMs) | $($b.outputMs) | $($b.totalMs) | $($d.RenderPaddingP50Frames)/$($d.RenderPaddingP95Frames)/$($d.RenderPaddingP99Frames) | $($d.XRuns)/$($d.RenderStarvedFrames) | $($d.InputRawProcessing)/$($d.OutputRawProcessing) | $($d.SharedClient3Available) | $($b.causes -join ', ') |"
        }
        $report += @('', 'The endpoint/output residual is a software presentation estimate, not measured DAC or headphone latency.',
            'Requested periods are benchmark settings only; this tool does not change application period selection policy.',
            'Inspect summary.json for full period negotiation, capture cadence, wait, padding, buffer, and error diagnostics.')
        $report | Set-Content -LiteralPath (Join-Path $runDirectory 'REPORT.md') -Encoding UTF8
        if ($Zip) { Compress-Archive -Path (Join-Path $runDirectory '*') -DestinationPath "$runDirectory.zip" -Force }
        Write-Output $runDirectory
    } finally {
        Stop-Probe
        $env:AD_VOICE_AUDIO_ENDPOINT = $oldEndpoint
    }
    return
}

try {
    Start-Probe
    $devices = @(Invoke-Control @('GetDevices')) | ForEach-Object {
        if ($_ -match '^(?:0\|)?(\{[^,]+\}),(.+),1,1,\d+$') {
            [pscustomobject]@{ id = $matches[1]; name = $matches[2] }
        }
    }
    $selectedOutputs = @(Expand-DeviceIds $OutputDeviceIds)
    if ($selectedOutputs.Count -gt 0) {
        $devices = @($devices | Where-Object { $selectedOutputs -contains $_.id })
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
