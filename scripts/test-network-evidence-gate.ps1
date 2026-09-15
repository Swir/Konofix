param()

$ErrorActionPreference = 'Stop'
$validator = Join-Path $PSScriptRoot 'validate-network-test-report.ps1'
if (-not (Test-Path -LiteralPath $validator -PathType Leaf)) { throw 'Network evidence validator not found.' }

$temp = Join-Path ([IO.Path]::GetTempPath()) ("konofix-evidence-selftest-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null

function New-TestManifest([string]$Scenario, [string]$Path) {
    $checks = [ordered]@{
        world_a_to_b = 'PASS'; world_b_to_a = 'PASS'; room_discovery = 'PASS'
        file_a_to_b_sha256 = 'PASS'; file_b_to_a_sha256 = 'PASS'; client_reconnect = 'PASS'
        node_restart_recovery = 'PASS'; relay_observed = 'N/A'; dcutr_direct_upgrade = 'N/A'
        nickname_conflict = 'PASS'
    }
    if ($Scenario -eq 'Relay' -or $Scenario -eq 'CGNAT') { $checks.relay_observed = 'PASS' }
    if ($Scenario -eq 'DCUtR') { $checks.dcutr_direct_upgrade = 'PASS' }
    $manifest = [ordered]@{
        schema_version = 2; created_utc = [DateTimeOffset]::UtcNow.ToString('o'); scenario = $Scenario
        build_version = '0.4.2'; node_version = '0.4.2'; client_a = 'selftest-a'; client_b = 'selftest-b'
        client_a_country = 'PL'; client_b_country = 'NO'; client_a_network = 'selftest-net-a'; client_b_network = 'selftest-net-b'
        bootstrap = '/dns/konofix.example.test/tcp/4001/p2p/12D3KooWSelfTestPeer123456789'; overall = 'PASS'; checks = $checks
    }
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Assert-Rejected([scriptblock]$Action, [string]$Name) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true; Write-Host "Expected rejection passed: $Name" }
    if (-not $rejected) { throw "Negative evidence self-test was accepted unexpectedly: $Name" }
}

try {
    $paths = @()
    foreach ($scenario in @('TCP','QUIC','Relay','DCUtR','CGNAT')) {
        $path = Join-Path $temp "$($scenario.ToLowerInvariant()).json"
        New-TestManifest -Scenario $scenario -Path $path
        $paths += $path
    }

    & $validator -Manifest $paths -RequireAllChecks -ExpectedBuildVersion '0.4.2' -ExpectedNodeVersion '0.4.2' -RequireSingleBootstrapPeer
    Write-Host 'Positive network evidence self-test passed.'

    $wrongVersion = Join-Path $temp 'wrong-version.json'
    Copy-Item $paths[0] $wrongVersion
    $data = Get-Content $wrongVersion -Raw | ConvertFrom-Json
    $data.build_version = '0.4.1'
    $data | ConvertTo-Json -Depth 5 | Set-Content $wrongVersion -Encoding UTF8
    Assert-Rejected { & $validator -Manifest $wrongVersion -RequiredScenario TCP -ExpectedBuildVersion '0.4.2' } 'wrong build version'

    $sameCountry = Join-Path $temp 'same-country.json'
    Copy-Item $paths[0] $sameCountry
    $data = Get-Content $sameCountry -Raw | ConvertFrom-Json
    $data.client_b_country = $data.client_a_country
    $data | ConvertTo-Json -Depth 5 | Set-Content $sameCountry -Encoding UTF8
    Assert-Rejected { & $validator -Manifest $sameCountry -RequiredScenario TCP } 'same-country Internet evidence'

    $fakeOverall = Join-Path $temp 'incomplete-core.json'
    Copy-Item $paths[0] $fakeOverall
    $data = Get-Content $fakeOverall -Raw | ConvertFrom-Json
    $data.checks.world_a_to_b = 'PENDING'
    $data | ConvertTo-Json -Depth 5 | Set-Content $fakeOverall -Encoding UTF8
    Assert-Rejected { & $validator -Manifest $fakeOverall -RequiredScenario TCP } 'overall PASS with incomplete core check'

    Write-Host 'Network evidence validator self-tests passed.'
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
