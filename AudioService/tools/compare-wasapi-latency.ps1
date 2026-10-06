param(
    [string[]]$ResultPaths = @(),
    [string]$ReportPath = '',
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

function Read-Metric($Row, [string]$Name) {
    $value = 0.0
    $raw = $Row.diagnostics.$Name
    if ($null -ne $raw) {
        [void][double]::TryParse([string]$raw, [Globalization.NumberStyles]::Float,
            [Globalization.CultureInfo]::InvariantCulture, [ref]$value)
    }
    return $value
}

function Read-Counter($Row, [string]$Name) {
    if ($Row.deltas -and $null -ne $Row.deltas.$Name) { return $Row.deltas.$Name }
    if ($Row.before) {
        return (Read-Metric $Row $Name) - [double]($Row.before.$Name)
    }
    return Read-Metric $Row $Name
}

function Get-Budget($Row) {
    if ($Row.breakdown) { return $Row.breakdown }
    $internal = (Read-Metric $Row 'LocalAudioServiceInternalMs') +
        (Read-Metric $Row 'LocalResamplerDspMs')
    return [pscustomobject]@{
        captureMs = Read-Metric $Row 'LocalCaptureDeviceMs'
        internalMs = $internal
        renderQueueMs = Read-Metric $Row 'LocalRenderQueueMs'
        outputMs = Read-Metric $Row 'LocalEndpointOutputMs'
        totalMs = Read-Metric $Row 'LocalEstimatedMonitoringMs'
    }
}

function Compare-LatencyRows($A, $B) {
    $left = Get-Budget $A
    $right = Get-Budget $B
    $parts = [ordered]@{}
    foreach ($key in @('captureMs', 'internalMs', 'renderQueueMs', 'outputMs', 'totalMs')) {
        $parts[$key] = [math]::Round(([double]$right.$key - [double]$left.$key), 3)
    }
    # These counters alone cannot prove a safe application-side reduction.
    $parts.provenRemovableMs = 0.0
    $parts.unattributedMs = $parts.totalMs
    return [pscustomobject]$parts
}

function Resolve-RowNames($Row, $Summary) {
    if (-not $Row.inputName) {
        $name = if ($Row.inputId) { $Row.inputId } else { $Summary.inputDeviceId }
        $Row | Add-Member -NotePropertyName inputName -NotePropertyValue $name -Force
    }
    if (-not $Row.outputName) {
        $device = $Summary.endpoints | Where-Object { $_.id -eq $Row.outputId } |
            Select-Object -First 1
        $name = if ($device) { $device.name } else { $Row.outputId }
        $Row | Add-Member -NotePropertyName outputName -NotePropertyValue $name -Force
    }
}

function Read-Result([string]$Path) {
    $file = if (Test-Path -LiteralPath $Path -PathType Container) {
        Join-Path $Path 'summary.json'
    } else { $Path }
    $data = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    $rows = if ($data.results) { @($data.results) }
            elseif ($data.finals) { @($data.finals) + @($data.qualifications) }
            else { @($data) }
    $shared = @($rows | Where-Object {
        $_.mode -eq 'shared' -and $_.estimatedMs -gt 0 -and -not $_.error
    } | Sort-Object @{ Expression = { -[int][bool]$_.softwareStable } }, estimatedMs)
    if ($shared.Count -eq 0) { throw "No measured Shared result in $file" }
    Resolve-RowNames $shared[0] $data
    return [pscustomobject]@{ path = $file; row = $shared[0] }
}

if ($SelfTest) {
    $a = [pscustomobject]@{
        breakdown = [pscustomobject]@{ captureMs = 10; internalMs = 2; renderQueueMs = 10; outputMs = 10; totalMs = 32 }
        diagnostics = @{ RuntimeOutputSampleRate = '48000'; SharedEnginePeriodActualFrames = '480'
            SharedEnginePeriodMinimumFrames = '480'; RenderPaddingP95Frames = '480'
            RenderStarvedFrames = '0' }
    }
    $b = [pscustomobject]@{
        breakdown = [pscustomobject]@{ captureMs = 20; internalMs = 2; renderQueueMs = 20; outputMs = 30; totalMs = 72 }
        diagnostics = @{ RuntimeOutputSampleRate = '48000'; SharedEnginePeriodActualFrames = '960'
            SharedEnginePeriodMinimumFrames = '960'; RenderPaddingP95Frames = '960'
            RenderStarvedFrames = '0' }
    }
    $difference = Compare-LatencyRows $a $b
    if ($difference.totalMs -ne 40 -or $difference.captureMs -ne 10 -or
        $difference.renderQueueMs -ne 10 -or $difference.outputMs -ne 20 -or
        $difference.provenRemovableMs -ne 0 -or $difference.unattributedMs -ne 40) {
        throw 'comparison must preserve measured deltas without inventing removable latency'
    }
    $legacy = [pscustomobject]@{ inputName = ''; outputName = ''; outputId = 'speaker' }
    Resolve-RowNames $legacy ([pscustomobject]@{
        inputDeviceId = 'mic'; endpoints = @([pscustomobject]@{ id = 'speaker'; name = 'Speakers' })
    })
    if ($legacy.inputName -ne 'mic' -or $legacy.outputName -ne 'Speakers') {
        throw 'legacy sweep rows must identify both endpoint IDs in comparisons'
    }
    $measured = [pscustomobject]@{ deltas = [pscustomobject]@{ RenderStarvedFrames = 7 }; diagnostics = @{ RenderStarvedFrames = '17' } }
    if ((Read-Counter $measured 'RenderStarvedFrames') -ne 7) {
        throw 'comparison must use window deltas when available'
    }
    Write-Output 'WASAPI comparison tests passed'
    exit 0
}

if ($ResultPaths.Count -lt 2) { throw 'Supply at least two summary.json files or result directories.' }
$results = @($ResultPaths | ForEach-Object { Read-Result $_ })
$baseline = $results[0]
$lines = @('# WASAPI Shared latency comparison', '',
    'Software estimates. Each artifact contributes its fastest stable Shared result, or its fastest measured Shared result if none was stable.',
    'A physical loopback measurement is needed to verify analog input-to-output latency.', '',
    '| Artifact | Input | Output | Requested/actual period | Rate | Capture | Internal | Render queue | Output residual | Total | Padding P95 | Starvation | RAW in/out | Client3 |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |')
foreach ($result in $results) {
    $row = $result.row
    $d = $row.diagnostics
    $b = Get-Budget $row
    $starvation = Read-Counter $row 'RenderStarvedFrames'
    $lines += "| $($result.path) | $($row.inputName) | $($row.outputName) | $($row.periodFrames)/$($d.SharedEnginePeriodActualFrames) | $($d.RuntimeOutputSampleRate) | $($b.captureMs) | $($b.internalMs) | $($b.renderQueueMs) | $($b.outputMs) | $($b.totalMs) | $($d.RenderPaddingP95Frames) | $starvation | $($d.InputRawProcessing)/$($d.OutputRawProcessing) | $($d.SharedClient3Available) |"
}
$lines += @('', "Baseline: $($baseline.path)", '')
foreach ($result in $results | Select-Object -Skip 1) {
    $diff = Compare-LatencyRows $baseline.row $result.row
    $lines += "## $($result.path) vs baseline", ''
    $lines += "Latency difference: $($diff.totalMs) ms"
    $lines += "Measured component deltas: capture $($diff.captureMs) ms; internal $($diff.internalMs) ms; render queue $($diff.renderQueueMs) ms; endpoint/output residual $($diff.outputMs) ms."
    $lines += "Proven safely removable by AudioService: $($diff.provenRemovableMs) ms. Cause not established by these measurements: $($diff.unattributedMs) ms."
    $lines += ''
}
if ($ReportPath) { $lines | Set-Content -LiteralPath $ReportPath -Encoding UTF8 }
$lines
