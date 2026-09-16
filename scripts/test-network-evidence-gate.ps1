param()

$ErrorActionPreference = 'Stop'
$validator = Join-Path $PSScriptRoot 'validate-network-test-report.ps1'
if (-not (Test-Path -LiteralPath $validator -PathType Leaf)) { throw 'Network evidence validator not found.' }

$temp = Join-Path ([IO.Path]::GetTempPath()) ("konofix-evidence-selftest-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null
$sourceCommit = '0123456789abcdef0123456789abcdef01234567'
$campaignId = '0123456789abcdef0123456789abcdef'

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
        schema_version = 3; campaign_id = $campaignId; created_utc = [DateTimeOffset]::UtcNow.ToString('o'); scenario = $Scenario
        build_version = '0.4.2'; node_version = '0.4.2'; source_commit = $sourceCommit; client_a = 'selftest-a'; client_b = 'selftest-b'
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
    $data | ConvertTo-Json -Depth 7 | Set-Content $path -Encoding UTF8
    return $path
}

try {
    $paths = @()
    foreach ($scenario in @('TCP','QUIC','Relay','DCUtR','CGNAT')) {
        $path = Join-Path $temp "$($scenario.ToLowerInvariant()).json"
        New-TestManifest -Scenario $scenario -Path $path
        $paths += $path
    }

    & $validator -Manifest $paths -RequireAllChecks -ExpectedBuildVersion '0.4.2' -ExpectedNodeVersion '0.4.2' -ExpectedSourceCommit $sourceCommit -RequireSingleBootstrapPeer -RequireSingleCampaign
    Write-Host 'Positive network evidence self-test passed.'

    $legacySchema = New-MutatedManifest $paths[0] 'legacy-schema.json' { param($d) $d.schema_version = 2 }
    Assert-Rejected { & $validator -Manifest $legacySchema -RequiredScenario TCP } 'legacy schema without commit-bound evidence'

    $stringSchema = New-MutatedManifest $paths[0] 'string-schema.json' { param($d) $d.schema_version = '3' }
    Assert-Rejected { & $validator -Manifest $stringSchema -RequiredScenario TCP } 'string-coerced schema version'

    $lowercaseScenario = New-MutatedManifest $paths[0] 'lowercase-scenario.json' { param($d) $d.scenario = 'tcp' }
    Assert-Rejected { & $validator -Manifest $lowercaseScenario -RequiredScenario TCP } 'non-canonical scenario casing'

    $wrongVersion = New-MutatedManifest $paths[0] 'wrong-version.json' { param($d) $d.build_version = '0.4.1' }
    Assert-Rejected { & $validator -Manifest $wrongVersion -RequiredScenario TCP -ExpectedBuildVersion '0.4.2' } 'wrong build version'

    $numericVersion = New-MutatedManifest $paths[0] 'numeric-version.json' { param($d) $d.build_version = 42 }
    Assert-Rejected { & $validator -Manifest $numericVersion -RequiredScenario TCP } 'numeric build version coercion'

    $wrongNodeVersion = New-MutatedManifest $paths[0] 'wrong-node-version.json' { param($d) $d.node_version = '0.4.1' }
    Assert-Rejected { & $validator -Manifest $wrongNodeVersion -RequiredScenario TCP -ExpectedNodeVersion '0.4.2' } 'wrong Node version'

    $wrongCommit = New-MutatedManifest $paths[0] 'wrong-commit.json' { param($d) $d.source_commit = '89abcdef0123456789abcdef0123456789abcdef' }
    Assert-Rejected { & $validator -Manifest $wrongCommit -RequiredScenario TCP -ExpectedSourceCommit $sourceCommit } 'wrong source commit'

    $malformedCommit = New-MutatedManifest $paths[0] 'malformed-commit.json' { param($d) $d.source_commit = 'not-a-commit' }
    Assert-Rejected { & $validator -Manifest $malformedCommit -RequiredScenario TCP } 'malformed source commit'

    $mixedCommit = @($paths)
    $mixedCommit[1] = New-MutatedManifest $paths[1] 'other-commit.json' { param($d) $d.source_commit = '89abcdef0123456789abcdef0123456789abcdef' }
    Assert-Rejected { & $validator -Manifest $mixedCommit -RequireAllChecks } 'mixed source commits'

    $missingCampaign = New-MutatedManifest $paths[0] 'missing-campaign.json' { param($d) $d.PSObject.Properties.Remove('campaign_id') }
    Assert-Rejected { & $validator -Manifest @($missingCampaign,$paths[1],$paths[2],$paths[3],$paths[4]) -RequireAllChecks -RequireSingleCampaign } 'missing campaign ID in promotion evidence'

    $numericCampaign = New-MutatedManifest $paths[0] 'numeric-campaign.json' { param($d) $d.campaign_id = 42 }
    Assert-Rejected { & $validator -Manifest $numericCampaign -RequiredScenario TCP } 'numeric campaign ID coercion'

    $malformedCampaign = New-MutatedManifest $paths[0] 'malformed-campaign.json' { param($d) $d.campaign_id = 'ABC-not-canonical' }
    Assert-Rejected { & $validator -Manifest $malformedCampaign -RequiredScenario TCP } 'malformed campaign ID'

    $mixedCampaign = @($paths)
    $mixedCampaign[1] = New-MutatedManifest $paths[1] 'other-campaign.json' { param($d) $d.campaign_id = '89abcdef0123456789abcdef01234567' }
    Assert-Rejected { & $validator -Manifest $mixedCampaign -RequireAllChecks -RequireSingleCampaign } 'mixed campaign IDs'

    $mixedClientA = @($paths)
    $mixedClientA[1] = New-MutatedManifest $paths[1] 'other-client-a.json' { param($d) $d.client_a = 'selftest-c' }
    Assert-Rejected { & $validator -Manifest $mixedClientA -RequireAllChecks -RequireSingleCampaign } 'mixed Client A identities inside one campaign'

    $mixedClientB = @($paths)
    $mixedClientB[2] = New-MutatedManifest $paths[2] 'other-client-b.json' { param($d) $d.client_b = 'selftest-c' }
    Assert-Rejected { & $validator -Manifest $mixedClientB -RequireAllChecks -RequireSingleCampaign } 'mixed Client B identities inside one campaign'

    $swappedClients = @($paths)
    $swappedClients[3] = New-MutatedManifest $paths[3] 'swapped-clients.json' { param($d) $a=$d.client_a; $d.client_a=$d.client_b; $d.client_b=$a }
    Assert-Rejected { & $validator -Manifest $swappedClients -RequireAllChecks -RequireSingleCampaign } 'swapped client orientation inside one campaign'

    $mixedCountry = @($paths)
    $mixedCountry[1] = New-MutatedManifest $paths[1] 'other-country.json' { param($d) $d.client_a_country = 'DE' }
    Assert-Rejected { & $validator -Manifest $mixedCountry -RequireAllChecks -RequireSingleCampaign } 'mixed country metadata inside one campaign'

    $mixedNetwork = @($paths)
    $mixedNetwork[1] = New-MutatedManifest $paths[1] 'other-network.json' { param($d) $d.client_a_network = 'selftest-net-c' }
    Assert-Rejected { & $validator -Manifest $mixedNetwork -RequireAllChecks -RequireSingleCampaign } 'mixed network metadata inside one campaign'

    $sameCountry = New-MutatedManifest $paths[0] 'same-country.json' { param($d) $d.client_b_country = $d.client_a_country }
    Assert-Rejected { & $validator -Manifest $sameCountry -RequiredScenario TCP } 'same-country Internet evidence'

    $numericCountry = New-MutatedManifest $paths[0] 'numeric-country.json' { param($d) $d.client_a_country = 47 }
    Assert-Rejected { & $validator -Manifest $numericCountry -RequiredScenario TCP } 'numeric country coercion'

    $sameNetwork = New-MutatedManifest $paths[0] 'same-network.json' { param($d) $d.client_b_network = $d.client_a_network }
    Assert-Rejected { & $validator -Manifest $sameNetwork -RequiredScenario TCP } 'same-network Internet evidence'

    $sameClientCase = New-MutatedManifest $paths[0] 'same-client-case.json' { param($d) $d.client_b = ' SELFTEST-A ' }
    Assert-Rejected { & $validator -Manifest $sameClientCase -RequiredScenario TCP } 'same client endpoint after normalization'

    $fakeOverall = New-MutatedManifest $paths[0] 'incomplete-core.json' { param($d) $d.checks.world_a_to_b = 'PENDING' }
    Assert-Rejected { & $validator -Manifest $fakeOverall -RequiredScenario TCP } 'overall PASS with incomplete core check'

    $lowercaseResult = New-MutatedManifest $paths[0] 'lowercase-result.json' { param($d) $d.checks.world_a_to_b = 'pass' }
    Assert-Rejected { & $validator -Manifest $lowercaseResult -RequiredScenario TCP } 'non-canonical check result casing'

    $booleanResult = New-MutatedManifest $paths[0] 'boolean-result.json' { param($d) $d.checks.world_a_to_b = $true }
    Assert-Rejected { & $validator -Manifest $booleanResult -RequiredScenario TCP } 'boolean check result coercion'

    $invalidTimestampType = New-MutatedManifest $paths[0] 'numeric-created-utc.json' { param($d) $d.created_utc = 1234567890 }
    Assert-Rejected { & $validator -Manifest $invalidTimestampType -RequiredScenario TCP } 'numeric timestamp coercion'

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
    Assert-Rejected { & $validator -Manifest $mixedBootstrap -RequireAllChecks -ExpectedBuildVersion '0.4.2' -ExpectedNodeVersion '0.4.2' -ExpectedSourceCommit $sourceCommit -RequireSingleBootstrapPeer -RequireSingleCampaign } 'mixed public Node Peer IDs'

    $oversized = Join-Path $temp 'oversized.json'
    Copy-Item $paths[0] $oversized
    Add-Content -LiteralPath $oversized -Value (' ' * 8192) -NoNewline
    Assert-Rejected { & $validator -Manifest $oversized -RequiredScenario TCP -MaxManifestBytes 4096 } 'oversized evidence manifest before JSON parsing'

    Write-Host 'Network evidence validator self-tests passed.'
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
