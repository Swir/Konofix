param()

$ErrorActionPreference = 'Stop'
$generator = Join-Path $PSScriptRoot 'new-network-test-campaign.ps1'
if (-not (Test-Path -LiteralPath $generator -PathType Leaf)) { throw 'Network campaign generator not found.' }

$temp = Join-Path ([IO.Path]::GetTempPath()) ("konofix-campaign-selftest-" + [Guid]::NewGuid().ToString('N'))
$sourceCommit = '0123456789abcdef0123456789abcdef01234567'
$campaignId = '0123456789abcdef0123456789abcdef'

function Assert-Rejected([scriptblock]$Action, [string]$Name) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true; Write-Host "Expected rejection passed: $Name" }
    if (-not $rejected) { throw "Negative campaign-generator self-test was accepted unexpectedly: $Name" }
}

try {
    New-Item -ItemType Directory -Force -Path $temp | Out-Null
    $buildInfoPath = Join-Path $temp 'BUILD_INFO.json'
    [ordered]@{
        schema = 1
        product = 'Konofix Chat'
        version = '0.4.2'
        commit = $sourceCommit
    } | ConvertTo-Json | Set-Content -LiteralPath $buildInfoPath -Encoding UTF8

    & $generator `
        -ClientA 'PC-A' -ClientACountry 'Norway' -ClientANetwork 'Operator-A' `
        -ClientB 'PC-B' -ClientBCountry 'Poland' -ClientBNetwork 'Operator-B' `
        -Bootstrap '/dns/node.example.test/tcp/45555/p2p/12D3KooWCampaignSelfTestPeer123456789' `
        -BuildInfoPath $buildInfoPath -CampaignId $campaignId `
        -OutputDirectory $temp -Notes 'campaign self-test' | Out-Null

    $campaignDir = Join-Path $temp "campaign-$campaignId"
    if (-not (Test-Path -LiteralPath $campaignDir -PathType Container)) { throw 'Campaign directory was not created.' }
    $manifests = @(Get-ChildItem -LiteralPath $campaignDir -Filter '*.json' -File)
    $markdown = @(Get-ChildItem -LiteralPath $campaignDir -Filter '*.md' -File)
    if ($manifests.Count -ne 5 -or $markdown.Count -ne 5) { throw 'Campaign generator must create exactly five JSON and five Markdown scenario reports.' }

    $scenarios = @()
    foreach ($manifest in $manifests) {
        $data = Get-Content -LiteralPath $manifest.FullName -Raw | ConvertFrom-Json
        if ($data.schema_version -ne 3) { throw 'Generated campaign manifest must use schema v3.' }
        if ([string]$data.campaign_id -cne $campaignId) { throw 'Generated campaign manifest has the wrong campaign_id.' }
        if ([string]$data.build_version -cne '0.4.2' -or [string]$data.node_version -cne '0.4.2') { throw 'Generated campaign did not inherit BUILD_INFO version.' }
        if ([string]$data.source_commit -cne $sourceCommit) { throw 'Generated campaign manifest has the wrong source commit.' }
        if ([string]$data.overall -cne 'PENDING') { throw 'Campaign generator must never pre-mark evidence as PASS.' }
        $scenarios += [string]$data.scenario
        $report = [IO.Path]::ChangeExtension($manifest.FullName, '.md')
        $reportText = Get-Content -LiteralPath $report -Raw
        if ($reportText -notmatch [regex]::Escape($campaignId)) { throw 'Generated Markdown report does not contain its campaign ID.' }
    }
    foreach ($scenario in @('TCP','QUIC','Relay','DCUtR','CGNAT')) {
        if ($scenarios -cnotcontains $scenario) { throw "Generated campaign is missing scenario: $scenario" }
    }

    Assert-Rejected {
        & $generator -ClientA A -ClientB B -ClientACountry NO -ClientBCountry PL -ClientANetwork NetA -ClientBNetwork NetB -Bootstrap '/dns/node.example.test/tcp/45555/p2p/12D3KooWCampaignSelfTestPeer123456789' -BuildInfoPath $buildInfoPath -BuildVersion '0.4.1' -OutputDirectory (Join-Path $temp 'bad-build') | Out-Null
    } 'BuildVersion mismatching BUILD_INFO'

    Assert-Rejected {
        & $generator -ClientA A -ClientB B -ClientACountry NO -ClientBCountry PL -ClientANetwork NetA -ClientBNetwork NetB -Bootstrap '/dns/node.example.test/tcp/45555/p2p/12D3KooWCampaignSelfTestPeer123456789' -BuildInfoPath $buildInfoPath -NodeVersion '0.4.1' -OutputDirectory (Join-Path $temp 'bad-node') | Out-Null
    } 'NodeVersion mismatching BUILD_INFO'

    Assert-Rejected {
        & $generator -ClientA A -ClientB B -ClientACountry NO -ClientBCountry PL -ClientANetwork NetA -ClientBNetwork NetB -Bootstrap '/dns/node.example.test/tcp/45555/p2p/12D3KooWCampaignSelfTestPeer123456789' -BuildInfoPath $buildInfoPath -SourceCommit '89abcdef0123456789abcdef0123456789abcdef' -OutputDirectory (Join-Path $temp 'bad-commit') | Out-Null
    } 'SourceCommit mismatching BUILD_INFO'

    Assert-Rejected {
        & $generator -ClientA A -ClientB B -ClientACountry NO -ClientBCountry NO -ClientANetwork NetA -ClientBNetwork NetB -Bootstrap '/dns/node.example.test/tcp/45555/p2p/12D3KooWCampaignSelfTestPeer123456789' -BuildInfoPath $buildInfoPath -OutputDirectory (Join-Path $temp 'bad-country') | Out-Null
    } 'same-country campaign'

    Assert-Rejected {
        & $generator -ClientA A -ClientB B -ClientACountry NO -ClientBCountry PL -ClientANetwork SameNet -ClientBNetwork SameNet -Bootstrap '/dns/node.example.test/tcp/45555/p2p/12D3KooWCampaignSelfTestPeer123456789' -BuildInfoPath $buildInfoPath -OutputDirectory (Join-Path $temp 'bad-network') | Out-Null
    } 'same-network campaign'

    Assert-Rejected {
        & $generator -ClientA A -ClientB B -ClientACountry NO -ClientBCountry PL -ClientANetwork NetA -ClientBNetwork NetB -Bootstrap '/dns/node.example.test/tcp/45555/p2p/12D3KooWCampaignSelfTestPeer123456789' -BuildInfoPath $buildInfoPath -CampaignId 'NOT-CANONICAL' -OutputDirectory (Join-Path $temp 'bad-id') | Out-Null
    } 'malformed campaign ID'

    Assert-Rejected {
        & $generator -ClientA SAME -ClientB same -ClientACountry NO -ClientBCountry PL -ClientANetwork NetA -ClientBNetwork NetB -Bootstrap '/dns/node.example.test/tcp/45555/p2p/12D3KooWCampaignSelfTestPeer123456789' -BuildInfoPath $buildInfoPath -OutputDirectory (Join-Path $temp 'bad-client') | Out-Null
    } 'same client endpoint'

    $badBuildInfo = Join-Path $temp 'BUILD_INFO-bad.json'
    '{"schema":1,"product":"Other Product","version":"0.4.2","commit":"0123456789abcdef0123456789abcdef01234567"}' | Set-Content -LiteralPath $badBuildInfo -Encoding UTF8
    Assert-Rejected {
        & $generator -ClientA A -ClientB B -ClientACountry NO -ClientBCountry PL -ClientANetwork NetA -ClientBNetwork NetB -Bootstrap '/dns/node.example.test/tcp/45555/p2p/12D3KooWCampaignSelfTestPeer123456789' -BuildInfoPath $badBuildInfo -OutputDirectory (Join-Path $temp 'bad-build-info') | Out-Null
    } 'invalid BUILD_INFO product'

    Write-Host 'Network campaign generator self-tests passed.'
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
