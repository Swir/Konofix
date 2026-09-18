$ErrorActionPreference = 'Stop'

$helper = Join-Path $PSScriptRoot 'path-identity.ps1'
$validator = Join-Path $PSScriptRoot 'validate-network-test-session.ps1'
if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw "Path identity helper not found: $helper" }
if (-not (Test-Path -LiteralPath $validator -PathType Leaf)) { throw "Session validator not found: $validator" }
. $helper

$expectedComparison = if ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)) {
    [System.StringComparison]::OrdinalIgnoreCase
} else {
    [System.StringComparison]::Ordinal
}
if ((Get-KonofixPathComparison) -ne $expectedComparison) {
    throw "Unexpected path comparison mode. expected=$expectedComparison actual=$(Get-KonofixPathComparison)"
}

$root = Join-Path ([IO.Path]::GetTempPath()) ('konofix-path-identity-' + [Guid]::NewGuid().ToString('N'))
$upper = Join-Path $root 'SessionCase'
$lower = Join-Path $root 'sessioncase'
try {
    New-Item -ItemType Directory -Path $upper -Force | Out-Null
    if (-not (Test-KonofixSameDirectory -Left $upper -Right $upper)) {
        throw 'Exact directory identity must be accepted.'
    }
    $normalized = Join-Path $upper '.'
    if (-not (Test-KonofixSameDirectory -Left $upper -Right $normalized)) {
        throw 'Normalized paths that identify the same directory must be accepted.'
    }

    if ($expectedComparison -eq [System.StringComparison]::OrdinalIgnoreCase) {
        if (-not (Test-KonofixSameDirectory -Left $upper -Right $lower)) {
            throw 'Windows directory identity must remain case-insensitive.'
        }
    } else {
        New-Item -ItemType Directory -Path $lower -Force | Out-Null
        if (Test-KonofixSameDirectory -Left $upper -Right $lower) {
            throw 'Case-sensitive platforms must reject a case-variant sibling directory.'
        }
    }

    $validatorSource = Get-Content -LiteralPath $validator -Raw
    $helperLoad = ". (Join-Path `$PSScriptRoot 'path-identity.ps1')"
    if (-not $validatorSource.Contains($helperLoad)) {
        throw 'Session validator must load the shared path identity helper.'
    }
    $helperCall = 'Test-KonofixSameDirectory -Left $manifestDirectory -Right $sessionDirectory'
    if (-not $validatorSource.Contains($helperCall)) {
        throw 'Session validator must use platform-correct directory identity for manifest confinement.'
    }
    if ($validatorSource -match '\[string\]::Equals\(\$manifestDirectory,\s*\$sessionDirectory,\s*\[StringComparison\]::OrdinalIgnoreCase\)') {
        throw 'Session validator regressed to unconditional case-insensitive directory comparison.'
    }
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'Network-test session path identity policy passed.' -ForegroundColor Green
