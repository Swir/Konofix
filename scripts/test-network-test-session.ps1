$ErrorActionPreference = 'Stop'
$target = Join-Path $PSScriptRoot 'new-network-test-session.ps1'
$validator = Join-Path $PSScriptRoot 'validate-network-test-session.ps1'
$peer = '12D3KooW9tHTtS3inCZiYykw4u5G4frbjVFqhkmJX12gSNCVeH3e'
$otherPeer = 'QmNQa1FSTXNHmrjjfgUW3Px3Vkke4oKiFWdigWkYSux2Pi'
$commit = '0123456789abcdef0123456789abcdef01234567'

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function New-BuildFixture([string]$Root, [string]$Commit = $commit) {
    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    $nodePath = Join-Path $Root 'konofix-node.exe'
    [IO.File]::WriteAllBytes($nodePath, [Text.Encoding]::UTF8.GetBytes('konofix-test-node-bytes'))
    $node = Get-Item -LiteralPath $nodePath
    $nodeHash = (Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $buildInfo = [ordered]@{
        schema = 2
        product = 'Konofix Chat'
        version = '0.4.2'
        commit = $Commit
        workflow_run = 'test'
        generated_utc = [DateTimeOffset]::UtcNow.ToString('o')
        node = [ordered]@{
            path = 'konofix-node.exe'
            bytes = [int64]$node.Length
            sha256 = $nodeHash
        }
        files = @([ordered]@{
            path = 'konofix-node.exe'
            bytes = [int64]$node.Length
            sha256 = $nodeHash
        })
    }
    $buildInfoPath = Join-Path $Root 'BUILD_INFO.json'
    $buildInfo | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $buildInfoPath -Encoding utf8
    return $buildInfoPath
}

function Invoke-Session([string]$BuildInfoPath, [string]$OutputRoot, [string]$Name, [string]$Tcp, [string]$Quic, [string]$CountryB = 'Poland', [string]$NetworkB = 'Operator-B LTE') {
    & $target `
        -ClientA 'PC-A' -ClientACountry 'Norway' -ClientANetwork 'Operator-A LTE' `
        -ClientB 'PC-B' -ClientBCountry $CountryB -ClientBNetwork $NetworkB `
        -TcpBootstrap $Tcp -QuicBootstrap $Quic `
        -BuildInfoPath $BuildInfoPath -OutputRoot $OutputRoot -SessionName $Name -Notes 'CI fixture' | Out-Null
}

function Expect-Fail([string]$Name, [scriptblock]$Action) {
    $failed = $false
    try {
        & $Action
    } catch {
        $failed = $true
    }
    if (-not $failed) { throw "Expected failure for '$Name'." }
    Write-Host "PASS (rejected): $Name" -ForegroundColor Green
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ('konofix-session-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    $fixtureRoot = Join-Path $temp 'bundle'
    $buildInfoPath = New-BuildFixture $fixtureRoot
    $outputRoot = Join-Path $temp 'results'
    $tcp = "/ip4/8.8.8.8/tcp/45555/p2p/$peer"
    $quic = "/ip4/8.8.8.8/udp/45555/quic-v1/p2p/$peer"

    Invoke-Session -BuildInfoPath $buildInfoPath -OutputRoot $outputRoot -Name 'valid-session' -Tcp $tcp -Quic $quic
    $sessionRoot = Join-Path $outputRoot 'valid-session'
    $sessionInfoPath = Join-Path $sessionRoot 'SESSION_INFO.json'
    Assert-True (Test-Path -LiteralPath $sessionRoot -PathType Container) 'Valid session directory was not created.'
    Assert-True (Test-Path -LiteralPath (Join-Path $sessionRoot 'BUILD_INFO.json') -PathType Leaf) 'Exact BUILD_INFO.json was not copied into the session.'
    Assert-True (Test-Path -LiteralPath $sessionInfoPath -PathType Leaf) 'SESSION_INFO.json was not created.'

    $session = Get-Content -LiteralPath $sessionInfoPath -Raw | ConvertFrom-Json
    Assert-True ([int]$session.schema_version -eq 1) 'Session schema mismatch.'
    Assert-True ([string]$session.build_version -ceq '0.4.2') 'Session build version mismatch.'
    Assert-True ([string]$session.source_commit -ceq $commit) 'Session source commit mismatch.'
    Assert-True ([string]$session.bootstrap_peer_id -ceq $peer) 'Session bootstrap Peer ID mismatch.'
    Assert-True ([string]$session.tcp_bootstrap -ceq $tcp) 'Session TCP bootstrap mismatch.'
    Assert-True ([string]$session.quic_bootstrap -ceq $quic) 'Session QUIC bootstrap mismatch.'
    Assert-True (@($session.manifests).Count -eq 5) 'Session must inventory exactly five manifests.'

    $manifests = @(Get-ChildItem -LiteralPath $sessionRoot -Filter 'network-test-*.json' -File)
    Assert-True ($manifests.Count -eq 5) 'Valid session must contain exactly five network manifests.'
    $manifestPaths = @($manifests | ForEach-Object FullName)
    $seen = @{}
    foreach ($file in $manifests) {
        $manifest = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
        $seen[[string]$manifest.scenario] = $true
        Assert-True ([int]$manifest.schema_version -eq 3) "Manifest $($file.Name) schema mismatch."
        Assert-True ([string]$manifest.source_commit -ceq $commit) "Manifest $($file.Name) source commit mismatch."
        Assert-True ([string]$manifest.build_version -ceq '0.4.2') "Manifest $($file.Name) build version mismatch."
        Assert-True ([string]$manifest.node_version -ceq '0.4.2') "Manifest $($file.Name) Node version mismatch."
        Assert-True ([string]$manifest.overall -ceq 'PENDING') "Manifest $($file.Name) must start PENDING."
        Assert-True ([string]$manifest.client_a_country -ceq 'Norway') "Manifest $($file.Name) Client A country mismatch."
        Assert-True ([string]$manifest.client_b_country -ceq 'Poland') "Manifest $($file.Name) Client B country mismatch."
        if ([string]$manifest.scenario -ceq 'QUIC') {
            Assert-True ([string]$manifest.bootstrap -ceq $quic) 'QUIC scenario must use the QUIC bootstrap address.'
        } else {
            Assert-True ([string]$manifest.bootstrap -ceq $tcp) "$($manifest.scenario) scenario must use the paired TCP bootstrap address."
        }
    }
    foreach ($required in @('TCP','QUIC','Relay','DCUtR','CGNAT')) {
        Assert-True ($seen.ContainsKey($required)) "Missing generated scenario: $required"
    }
    $tmpEntries = @(Get-ChildItem -LiteralPath $outputRoot -Force | Where-Object { $_.Name -like '.*.tmp' })
    Assert-True ($tmpEntries.Count -eq 0) 'Successful session left a temporary staging directory.'

    $copiedBuildInfo = Join-Path $sessionRoot 'BUILD_INFO.json'
    $copiedBuildHash = (Get-FileHash -LiteralPath $copiedBuildInfo -Algorithm SHA256).Hash.ToLowerInvariant()
    $nodeHash = (Get-FileHash -LiteralPath (Join-Path $fixtureRoot 'konofix-node.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
    $validated = (& $validator `
        -SessionInfoPath $sessionInfoPath `
        -Manifest $manifestPaths `
        -ExpectedBuildVersion '0.4.2' `
        -ExpectedNodeVersion '0.4.2' `
        -ExpectedSourceCommit $commit `
        -ExpectedBuildInfoSha256 $copiedBuildHash `
        -ExpectedNodeSha256 $nodeHash `
        -ExpectedBootstrapPeerId $peer `
        -AsJson) | ConvertFrom-Json
    Assert-True ([string]$validated.status -ceq 'PASS') 'Session consistency validator did not return PASS.'
    Assert-True ([int]$validated.schema -eq 2) 'Session consistency validator schema mismatch.'
    Assert-True ([bool]$validated.public_host_validated) 'Session consistency validator did not record public-host validation.'
    Assert-True ([int]$validated.manifest_count -eq 5) 'Session consistency validator did not report five manifests.'
    Write-Host 'PASS: valid exact-build five-scenario session, public endpoint policy and session consistency' -ForegroundColor Green

    $tcpManifestPath = ($manifests | Where-Object { (Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json).scenario -ceq 'TCP' } | Select-Object -First 1).FullName
    $originalTcpManifest = Get-Content -LiteralPath $tcpManifestPath -Raw
    $mixedEndpoint = $originalTcpManifest | ConvertFrom-Json
    $mixedEndpoint.client_b_country = 'Germany'
    $mixedEndpoint | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $tcpManifestPath -Encoding utf8
    Expect-Fail 'mixed endpoint metadata inside one session' {
        & $validator -SessionInfoPath $sessionInfoPath -Manifest $manifestPaths | Out-Null
    }
    Set-Content -LiteralPath $tcpManifestPath -Value $originalTcpManifest -Encoding utf8

    $wrongBootstrap = $originalTcpManifest | ConvertFrom-Json
    $wrongBootstrap.bootstrap = "/ip4/1.1.1.1/tcp/45555/p2p/$otherPeer"
    $wrongBootstrap | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $tcpManifestPath -Encoding utf8
    Expect-Fail 'manifest bootstrap outside paired session identity' {
        & $validator -SessionInfoPath $sessionInfoPath -Manifest $manifestPaths | Out-Null
    }
    Set-Content -LiteralPath $tcpManifestPath -Value $originalTcpManifest -Encoding utf8

    $originalSessionInfo = Get-Content -LiteralPath $sessionInfoPath -Raw
    $wrongBuildHash = $originalSessionInfo | ConvertFrom-Json
    $wrongBuildHash.build_info_sha256 = ('0' * 64)
    $wrongBuildHash | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $sessionInfoPath -Encoding utf8
    Expect-Fail 'session BUILD_INFO hash pin mismatch' {
        & $validator -SessionInfoPath $sessionInfoPath -Manifest $manifestPaths -ExpectedBuildInfoSha256 $copiedBuildHash | Out-Null
    }
    Set-Content -LiteralPath $sessionInfoPath -Value $originalSessionInfo -Encoding utf8

    $nonPublicSession = $originalSessionInfo | ConvertFrom-Json
    $nonPublicSession.tcp_bootstrap = "/ip4/203.0.113.10/tcp/45555/p2p/$peer"
    $nonPublicSession.quic_bootstrap = "/ip4/203.0.113.10/udp/45555/quic-v1/p2p/$peer"
    $nonPublicSession | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $sessionInfoPath -Encoding utf8
    Expect-Fail 'tampered session using documentation-only bootstrap' {
        & $validator -SessionInfoPath $sessionInfoPath -Manifest $manifestPaths | Out-Null
    }
    Set-Content -LiteralPath $sessionInfoPath -Value $originalSessionInfo -Encoding utf8

    $tamperRoot = Join-Path $temp 'tampered-bundle'
    $tamperBuild = New-BuildFixture $tamperRoot
    Add-Content -LiteralPath (Join-Path $tamperRoot 'konofix-node.exe') -Value 'tamper' -Encoding ascii
    Expect-Fail 'tampered packaged Node bytes' {
        Invoke-Session -BuildInfoPath $tamperBuild -OutputRoot $outputRoot -Name 'tampered-node' -Tcp $tcp -Quic $quic
    }
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $outputRoot 'tampered-node'))) 'Tampered Node failure left a final session directory.'

    $mismatchQuic = "/ip4/8.8.8.8/udp/45555/quic-v1/p2p/$otherPeer"
    Expect-Fail 'mismatched TCP/QUIC Peer IDs' {
        Invoke-Session -BuildInfoPath $buildInfoPath -OutputRoot $outputRoot -Name 'peer-mismatch' -Tcp $tcp -Quic $mismatchQuic
    }
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $outputRoot 'peer-mismatch'))) 'Peer mismatch failure left a final session directory.'

    $documentationTcp = "/ip4/203.0.113.10/tcp/45555/p2p/$peer"
    $documentationQuic = "/ip4/203.0.113.10/udp/45555/quic-v1/p2p/$peer"
    Expect-Fail 'documentation-only bootstrap cannot create promotion session' {
        Invoke-Session -BuildInfoPath $buildInfoPath -OutputRoot $outputRoot -Name 'documentation-bootstrap' -Tcp $documentationTcp -Quic $documentationQuic
    }
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $outputRoot 'documentation-bootstrap'))) 'Non-public bootstrap failure left a final session directory.'

    Expect-Fail 'same network/operator' {
        Invoke-Session -BuildInfoPath $buildInfoPath -OutputRoot $outputRoot -Name 'same-network' -Tcp $tcp -Quic $quic -NetworkB 'Operator-A LTE'
    }
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $outputRoot 'same-network'))) 'Same-network failure left a final session directory.'

    Expect-Fail 'same country' {
        Invoke-Session -BuildInfoPath $buildInfoPath -OutputRoot $outputRoot -Name 'same-country' -Tcp $tcp -Quic $quic -CountryB 'Norway'
    }
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $outputRoot 'same-country'))) 'Same-country failure left a final session directory.'

    Expect-Fail 'refuse overwrite of existing session' {
        Invoke-Session -BuildInfoPath $buildInfoPath -OutputRoot $outputRoot -Name 'valid-session' -Tcp $tcp -Quic $quic
    }

    $upperRoot = Join-Path $temp 'uppercase-commit-bundle'
    $upperBuild = New-BuildFixture $upperRoot -Commit $commit.ToUpperInvariant()
    Expect-Fail 'non-canonical uppercase source commit' {
        Invoke-Session -BuildInfoPath $upperBuild -OutputRoot $outputRoot -Name 'uppercase-commit' -Tcp $tcp -Quic $quic
    }

    Write-Host 'Network test session self-tests passed.' -ForegroundColor Cyan
} finally {
    if (Test-Path -LiteralPath $temp) {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    }
}
