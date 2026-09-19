[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ClientA,
    [Parameter(Mandatory = $true)][string]$ClientACountry,
    [Parameter(Mandatory = $true)][string]$ClientANetwork,
    [Parameter(Mandatory = $true)][string]$ClientB,
    [Parameter(Mandatory = $true)][string]$ClientBCountry,
    [Parameter(Mandatory = $true)][string]$ClientBNetwork,
    [Parameter(Mandatory = $true)][string]$TcpBootstrap,
    [Parameter(Mandatory = $true)][string]$QuicBootstrap,
    [string]$BuildInfoPath = '',
    [string]$OutputRoot = 'test-results',
    [string]$SessionName = '',
    [string]$Notes = ''
)

$ErrorActionPreference = 'Stop'

$snapshotHelper = Join-Path $PSScriptRoot 'evidence-snapshot.ps1'
if (-not (Test-Path -LiteralPath $snapshotHelper -PathType Leaf)) {
    throw "Required evidence snapshot helper is missing: $snapshotHelper"
}
. $snapshotHelper

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Assert-Different([string]$Left, [string]$Right, [string]$Message) {
    if ([string]::Equals($Left.Trim(), $Right.Trim(), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw $Message
    }
}

function Parse-Bootstrap([string]$Address, [string]$InternetTestPath) {
    $jsonText = (& $InternetTestPath -Bootstrap $Address -ValidateOnly -AsJson -RequirePublicHost -RequireDnsResolution | Out-String).Trim()
    Assert-True (-not [string]::IsNullOrWhiteSpace($jsonText)) "Bootstrap validation returned no structured result for: $Address"
    try {
        $parsed = $jsonText | ConvertFrom-Json
    } catch {
        throw "Bootstrap validation returned invalid JSON for '$Address': $($_.Exception.Message)"
    }
    Assert-True ([bool]$parsed.public_host_validated) "Bootstrap did not pass the globally-routable public-host policy: $Address"
    return $parsed
}

$bundleRoot = Split-Path $PSScriptRoot -Parent
$internetTest = Join-Path $PSScriptRoot 'internet-test.ps1'
$reportGenerator = Join-Path $PSScriptRoot 'new-network-test-report.ps1'
foreach ($requiredScript in @($internetTest, $reportGenerator)) {
    Assert-True (Test-Path -LiteralPath $requiredScript -PathType Leaf) "Required Konofix test script is missing: $requiredScript"
}

if ([string]::IsNullOrWhiteSpace($BuildInfoPath)) {
    $BuildInfoPath = Join-Path $bundleRoot 'BUILD_INFO.json'
}
$buildInfoSnapshot = Read-KonofixBoundedJsonSnapshot -Path $BuildInfoPath -MaxBytes (256KB) -Label 'BUILD_INFO.json'
$BuildInfoPath = [string]$buildInfoSnapshot.Path
$buildInfo = $buildInfoSnapshot.Data
$buildInfoHash = [string]$buildInfoSnapshot.Sha256

$schemaIsInteger = ($buildInfo.schema -is [int]) -or ($buildInfo.schema -is [long])
$buildInfoSchema = if ($schemaIsInteger) { [int64]$buildInfo.schema } else { -1 }
Assert-True ($schemaIsInteger -and $buildInfoSchema -in @(1, 2)) 'BUILD_INFO.json must use supported integer schema 1 or 2.'
Assert-True ([string]::Equals([string]$buildInfo.product, 'Konofix Chat', [System.StringComparison]::Ordinal)) 'BUILD_INFO.json contains the wrong product name.'
$version = [string]$buildInfo.version
Assert-True (-not [string]::IsNullOrWhiteSpace($version)) 'BUILD_INFO.json version is empty.'
$sourceCommit = [string]$buildInfo.commit
Assert-True ($sourceCommit -cmatch '^[0-9a-f]{40}$') 'BUILD_INFO.json commit must be a canonical lowercase 40-character Git SHA.'

$nodeMeta = $buildInfo.node
Assert-True ($null -ne $nodeMeta) 'BUILD_INFO.json is missing Node metadata.'
Assert-True ([string]::Equals([string]$nodeMeta.path, 'konofix-node.exe', [System.StringComparison]::Ordinal)) 'BUILD_INFO.json Node path must be konofix-node.exe.'
$nodeBytesIsInteger = ($nodeMeta.bytes -is [int]) -or ($nodeMeta.bytes -is [long])
Assert-True ($nodeBytesIsInteger -and [int64]$nodeMeta.bytes -gt 0) 'BUILD_INFO.json Node byte size must be a positive JSON integer.'
$nodeHash = [string]$nodeMeta.sha256
Assert-True ($nodeHash -cmatch '^[0-9a-f]{64}$') 'BUILD_INFO.json Node SHA-256 must be canonical lowercase hexadecimal.'

$buildRoot = Split-Path $BuildInfoPath -Parent
$nodePath = Join-Path $buildRoot 'konofix-node.exe'
$nodeLock = Open-KonofixVerifiedExecutable -Path $nodePath -ExpectedBytes ([int64]$nodeMeta.bytes) -ExpectedSha256 $nodeHash -Label 'Konofix Node'
$nodePath = [string]$nodeLock.Path
$nodeHash = [string]$nodeLock.Sha256

try {
    foreach ($entry in @(
        @{ Name = 'ClientA'; Value = $ClientA },
        @{ Name = 'ClientACountry'; Value = $ClientACountry },
        @{ Name = 'ClientANetwork'; Value = $ClientANetwork },
        @{ Name = 'ClientB'; Value = $ClientB },
        @{ Name = 'ClientBCountry'; Value = $ClientBCountry },
        @{ Name = 'ClientBNetwork'; Value = $ClientBNetwork }
    )) {
        Assert-True (-not [string]::IsNullOrWhiteSpace([string]$entry.Value)) "$($entry.Name) must not be empty."
        Assert-True (([string]$entry.Value).Length -le 160) "$($entry.Name) is too long."
    }
    Assert-Different $ClientA $ClientB 'Client A and Client B must identify different endpoints.'
    Assert-Different $ClientACountry $ClientBCountry 'Real Internet test clients must be in different countries.'
    Assert-Different $ClientANetwork $ClientBNetwork 'Real Internet test clients must use independent networks/operators.'

    $tcp = Parse-Bootstrap -Address $TcpBootstrap -InternetTestPath $internetTest
    $quic = Parse-Bootstrap -Address $QuicBootstrap -InternetTestPath $internetTest
    Assert-True ([string]$tcp.transport -ceq 'tcp') "TcpBootstrap must use TCP; parsed transport is '$($tcp.transport)'."
    Assert-True ([string]$quic.transport -ceq 'quic-v1') "QuicBootstrap must use UDP/QUIC v1; parsed transport is '$($quic.transport)'."
    Assert-True ([string]$tcp.host_protocol -ceq [string]$quic.host_protocol -and [string]$tcp.host -ceq [string]$quic.host) 'TCP and QUIC bootstrap addresses must describe exactly the same public host.'
    Assert-True ([int]$tcp.port -eq [int]$quic.port) 'TCP and QUIC bootstrap addresses must use the same port.'
    Assert-True ([string]$tcp.peer_id -ceq [string]$quic.peer_id) 'TCP and QUIC bootstrap addresses must use the same Konofix Node Peer ID.'

    if ([string]::IsNullOrWhiteSpace($SessionName)) {
        $SessionName = "konofix-real-network-$([DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss'))-$($sourceCommit.Substring(0, 8))"
    }
    Assert-True ($SessionName -cmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$') 'SessionName may contain only letters, numbers, dot, underscore and dash (1-96 characters).'

    $OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
    New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
    $finalDirectory = Join-Path $OutputRoot $SessionName
    Assert-True (-not (Test-Path -LiteralPath $finalDirectory)) "Test session already exists and will not be overwritten: $finalDirectory"
    $stagingDirectory = Join-Path $OutputRoot (".$SessionName.$([guid]::NewGuid().ToString('N')).tmp")
    New-Item -ItemType Directory -Path $stagingDirectory | Out-Null

    try {
        $scenarioBootstraps = [ordered]@{
            TCP = [string]$tcp.address
            QUIC = [string]$quic.address
            Relay = [string]$tcp.address
            DCUtR = [string]$tcp.address
            CGNAT = [string]$tcp.address
        }

        foreach ($scenario in $scenarioBootstraps.Keys) {
            & $reportGenerator `
                -Scenario $scenario `
                -ClientA $ClientA -ClientACountry $ClientACountry -ClientANetwork $ClientANetwork `
                -ClientB $ClientB -ClientBCountry $ClientBCountry -ClientBNetwork $ClientBNetwork `
                -BuildVersion $version -NodeVersion $version -SourceCommit $sourceCommit `
                -Bootstrap $scenarioBootstraps[$scenario] `
                -OutputDirectory $stagingDirectory `
                -Notes $Notes | Out-Null
        }

        $manifestFiles = @(Get-ChildItem -LiteralPath $stagingDirectory -Filter '*.json' -File | Where-Object { $_.Name -like 'network-test-*.json' } | Sort-Object Name)
        Assert-True ($manifestFiles.Count -eq 5) "Expected exactly five network-test manifests, found $($manifestFiles.Count)."

        $sessionBuildInfoPath = Join-Path $stagingDirectory 'BUILD_INFO.json'
        [IO.File]::WriteAllBytes($sessionBuildInfoPath, [byte[]]$buildInfoSnapshot.ContentBytes)
        $manifestInfo = @($manifestFiles | ForEach-Object {
            [ordered]@{
                path = $_.Name
                bytes = [int64]$_.Length
                sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        })

        $session = [ordered]@{
            schema_version = 1
            created_utc = [DateTimeOffset]::UtcNow.ToString('o')
            product = 'Konofix Chat'
            build_version = $version
            node_version = $version
            source_commit = $sourceCommit
            build_info_sha256 = $buildInfoHash
            node_sha256 = $nodeHash
            bootstrap_peer_id = [string]$tcp.peer_id
            tcp_bootstrap = [string]$tcp.address
            quic_bootstrap = [string]$quic.address
            client_a = [ordered]@{ id = $ClientA; country = $ClientACountry; network = $ClientANetwork }
            client_b = [ordered]@{ id = $ClientB; country = $ClientBCountry; network = $ClientBNetwork }
            manifests = $manifestInfo
            notes = $Notes
        }
        $session | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $stagingDirectory 'SESSION_INFO.json') -Encoding utf8

        Move-Item -LiteralPath $stagingDirectory -Destination $finalDirectory
        Write-Host '=== Konofix real-network test session ===' -ForegroundColor Cyan
        Write-Host "PASS: exact build $version / $sourceCommit and packaged Node bytes verified." -ForegroundColor Green
        Write-Host "PASS: globally-routable paired TCP/QUIC bootstrap host, port and Peer ID verified: $($tcp.peer_id)" -ForegroundColor Green
        Write-Host "Created five PENDING scenario manifests atomically under: $finalDirectory" -ForegroundColor Green
        Write-Host 'Next: run bootstrap reachability from both clients, execute each scenario, and record observations with set-network-test-result.ps1.' -ForegroundColor Yellow
    } catch {
        if (Test-Path -LiteralPath $stagingDirectory) {
            Remove-Item -LiteralPath $stagingDirectory -Recurse -Force -ErrorAction SilentlyContinue
        }
        throw
    }
} finally {
    $nodeLock.Stream.Dispose()
}
