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

function New-MutatedManifest([string]$Source, [string]$Name, [scriptblock]$Mutation) {
    $path = Join-Path $temp $Name
    Copy-Item $Source $path
    $data = Get-Content $path -Raw | ConvertFrom-Json
    & $Mutation $data
    $data | ConvertTo-Json -Depth 5 | Set-Content $path -Encoding UTF8
    return $path
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

    $wrongVersion = New-MutatedManifest $paths[0] 'wrong-version.json' { param($d) $d.build_version = '0.4.1' }
    Assert-Rejected { & $validator -Manifest $wrongVersion -RequiredScenario TCP -ExpectedBuildVersion '0.4.2' } 'wrong build version'

    $wrongNodeVersion = New-MutatedManifest $paths[0] 'wrong-node-version.json' { param($d) $d.node_version = '0.4.1' }
    Assert-Rejected { & $validator -Manifest $wrongNodeVersion -RequiredScenario TCP -ExpectedNodeVersion '0.4.2' } 'wrong Node version'

    $sameCountry = New-MutatedManifest $paths[0] 'same-country.json' { param($d) $d.client_b_country = $d.client_a_country }
    Assert-Rejected { & $validator -Manifest $sameCountry -RequiredScenario TCP } 'same-country Internet evidence'

    $sameNetwork = New-MutatedManifest $paths[0] 'same-network.json' { param($d) $d.client_b_network = $d.client_a_network }
    Assert-Rejected { & $validator -Manifest $sameNetwork -RequiredScenario TCP } 'same-network Internet evidence'

    $fakeOverall = New-MutatedManifest $paths[0] 'incomplete-core.json' { param($d) $d.checks.world_a_to_b = 'PENDING' }
    Assert-Rejected { & $validator -Manifest $fakeOverall -RequiredScenario TCP } 'overall PASS with incomplete core check'

    $stale = New-MutatedManifest $paths[0] 'stale.json' { param($d) $d.created_utc = [DateTimeOffset]::UtcNow.AddDays(-31).ToString('o') }
    Assert-Rejected { & $validator -Manifest $stale -RequiredScenario TCP -MaxAgeDays 30 } 'stale evidence'

    $future = New-MutatedManifest $paths[0] 'future.json' { param($d) $d.created_utc = [DateTimeOffset]::UtcNow.AddHours(1).ToString('o') }
    Assert-Rejected { & $validator -Manifest $future -RequiredScenario TCP } 'future-dated evidence'

    $relayMissing = New-MutatedManifest $paths[2] 'relay-missing.json' { param($d) $d.checks.relay_observed = 'N/A' }
    Assert-Rejected { & $validator -Manifest $relayMissing -RequiredScenario Relay } 'Relay PASS without observed relay'

    $dcutrMissing = New-MutatedManifest $paths[3] 'dcutr-missing.json' { param($d) $d.checks.dcutr_direct_upgrade = 'N/A' }
    Assert-Rejected { & $validator -Manifest $dcutrMissing -RequiredScenario DCUtR } 'DCUtR PASS without direct upgrade'

    $cgnatMissing = New-MutatedManifest $paths[4] 'cgnat-relay-missing.json' { param($d) $d.checks.relay_observed = 'N/A' }
    Assert-Rejected { & $validator -Manifest $cgnatMissing -RequiredScenario CGNAT } 'CGNAT PASS without relay proof'

    $mixedBootstrap = @($paths)
    $mixedBootstrap[1] = New-MutatedManifest $paths[1] 'other-bootstrap.json' { param($d) $d.bootstrap = '/dns/konofix.example.test/tcp/4001/p2p/12D3KooWAnotherPeer987654321' }
    Assert-Rejected { & $validator -Manifest $mixedBootstrap -RequireAllChecks -ExpectedBuildVersion '0.4.2' -ExpectedNodeVersion '0.4.2' -RequireSingleBootstrapPeer } 'mixed public Node Peer IDs'

    Write-Host 'Network evidence validator self-tests passed.'
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
