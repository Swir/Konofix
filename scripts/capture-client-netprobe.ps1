[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SessionInfoPath,
    [Parameter(Mandatory = $true)][ValidateSet('A','B')][string]$Client,
    [string]$BuildInfoPath = '',
    [string]$OutputPath = '',
    [ValidateRange(5, 120)][int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Read-BoundedJson([string]$Path, [int64]$MaxBytes, [string]$Label) {
    Assert-True (Test-Path -LiteralPath $Path -PathType Leaf) "$Label is missing: $Path"
    $item = Get-Item -LiteralPath $Path
    Assert-True ($item.Length -gt 0) "$Label is empty: $Path"
    Assert-True ($item.Length -le $MaxBytes) "$Label exceeds the maximum supported size of $MaxBytes bytes."
    try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json } catch { throw "$Label is not valid JSON: $($_.Exception.Message)" }
}

function Get-RequiredString($Object, [string]$Name, [string]$Label) {
    $property = $Object.PSObject.Properties[$Name]
    Assert-True ($null -ne $property -and $null -ne $property.Value) "$Label is missing required field '$Name'."
    Assert-True ($property.Value -is [string] -and -not [string]::IsNullOrWhiteSpace([string]$property.Value)) "$Label field '$Name' must be a non-empty JSON string."
    return [string]$property.Value
}

function Get-RequiredInt64($Object, [string]$Name, [string]$Label) {
    $property = $Object.PSObject.Properties[$Name]
    Assert-True ($null -ne $property -and $null -ne $property.Value) "$Label is missing required field '$Name'."
    $value = $property.Value
    $typeCode = [Type]::GetTypeCode($value.GetType())
    $integralTypes = @([TypeCode]::SByte,[TypeCode]::Byte,[TypeCode]::Int16,[TypeCode]::UInt16,[TypeCode]::Int32,[TypeCode]::UInt32,[TypeCode]::Int64,[TypeCode]::UInt64)
    Assert-True ($typeCode -in $integralTypes) "$Label field '$Name' must be a JSON integer."
    try { return [Convert]::ToInt64($value) } catch { throw "$Label field '$Name' is outside the signed 64-bit range." }
}

function Invoke-Netprobe([string]$NetprobePath, [string]$Target, [int]$Timeout) {
    $output = @(& $NetprobePath --timeout $Timeout $Target 2>&1)
    $exitCode = $LASTEXITCODE
    $text = ($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
    if ($exitCode -ne 0) {
        throw "Konofix Netprobe failed for '$Target' with exit code $exitCode.`n$text"
    }
    Assert-True (-not [string]::IsNullOrWhiteSpace($text)) "Konofix Netprobe returned no JSON evidence for '$Target'."
    try {
        $parsed = $text | ConvertFrom-Json
    } catch {
        throw "Konofix Netprobe returned invalid JSON for '$Target': $($_.Exception.Message)"
    }
    Assert-True ($parsed -is [pscustomobject]) "Konofix Netprobe evidence must be a JSON object for '$Target'."
    return $parsed
}

$sessionInfoPath = [IO.Path]::GetFullPath($SessionInfoPath)
$sessionDirectory = Split-Path $sessionInfoPath -Parent
$bundleRoot = Split-Path $PSScriptRoot -Parent
if ([string]::IsNullOrWhiteSpace($BuildInfoPath)) {
    $candidate = Join-Path $bundleRoot 'BUILD_INFO.json'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $BuildInfoPath = $candidate
    } else {
        $BuildInfoPath = Join-Path $sessionDirectory 'BUILD_INFO.json'
    }
}
$buildInfoPath = [IO.Path]::GetFullPath($BuildInfoPath)
$session = Read-BoundedJson -Path $sessionInfoPath -MaxBytes 262144 -Label 'SESSION_INFO.json'
$buildInfo = Read-BoundedJson -Path $buildInfoPath -MaxBytes 262144 -Label 'BUILD_INFO.json'
Assert-True ($session -is [pscustomobject] -and $buildInfo -is [pscustomobject]) 'SESSION_INFO and BUILD_INFO roots must be JSON objects.'
Assert-True ((Get-RequiredInt64 $session 'schema_version' 'SESSION_INFO') -eq 1) 'Unsupported SESSION_INFO schema.'
Assert-True ((Get-RequiredInt64 $buildInfo 'schema' 'BUILD_INFO') -eq 2) 'Authenticated client probes require BUILD_INFO schema 2.'

$version = Get-RequiredString $buildInfo 'version' 'BUILD_INFO'
$commit = Get-RequiredString $buildInfo 'commit' 'BUILD_INFO'
Assert-True ($commit -cmatch '^[0-9a-f]{40}$') 'BUILD_INFO commit must be a canonical lowercase 40-character Git SHA.'
Assert-True ([string]::Equals((Get-RequiredString $session 'build_version' 'SESSION_INFO'), $version, [StringComparison]::Ordinal)) 'SESSION_INFO build_version does not match BUILD_INFO.'
Assert-True ([string]::Equals((Get-RequiredString $session 'source_commit' 'SESSION_INFO'), $commit, [StringComparison]::Ordinal)) 'SESSION_INFO source_commit does not match BUILD_INFO.'

$actualBuildInfoHash = (Get-FileHash -LiteralPath $buildInfoPath -Algorithm SHA256).Hash.ToLowerInvariant()
$actualSessionInfoHash = (Get-FileHash -LiteralPath $sessionInfoPath -Algorithm SHA256).Hash.ToLowerInvariant()
Assert-True ([string]::Equals((Get-RequiredString $session 'build_info_sha256' 'SESSION_INFO'), $actualBuildInfoHash, [StringComparison]::Ordinal)) 'SESSION_INFO does not bind to this BUILD_INFO.json.'

$netprobeMeta = $buildInfo.PSObject.Properties['netprobe'].Value
Assert-True ($netprobeMeta -is [pscustomobject]) 'BUILD_INFO is missing netprobe metadata.'
$netprobeRelativePath = Get-RequiredString $netprobeMeta 'path' 'BUILD_INFO.netprobe'
Assert-True ([string]::Equals($netprobeRelativePath, 'konofix-netprobe.exe', [StringComparison]::Ordinal)) 'BUILD_INFO netprobe path must be konofix-netprobe.exe.'
$netprobeBytes = Get-RequiredInt64 $netprobeMeta 'bytes' 'BUILD_INFO.netprobe'
$netprobeHash = Get-RequiredString $netprobeMeta 'sha256' 'BUILD_INFO.netprobe'
Assert-True ($netprobeBytes -gt 0 -and $netprobeHash -cmatch '^[0-9a-f]{64}$') 'BUILD_INFO netprobe metadata is invalid.'
$netprobePath = Join-Path (Split-Path $buildInfoPath -Parent) $netprobeRelativePath
Assert-True (Test-Path -LiteralPath $netprobePath -PathType Leaf) "Verified Netprobe binary is missing beside BUILD_INFO.json: $netprobePath"
Assert-True ([int64](Get-Item -LiteralPath $netprobePath).Length -eq $netprobeBytes) 'Refusing to execute Netprobe: binary size does not match BUILD_INFO.'
$actualNetprobeHash = (Get-FileHash -LiteralPath $netprobePath -Algorithm SHA256).Hash.ToLowerInvariant()
Assert-True ([string]::Equals($actualNetprobeHash, $netprobeHash, [StringComparison]::Ordinal)) 'Refusing to execute Netprobe: binary SHA-256 does not match BUILD_INFO.'

$clientObject = if ($Client -ceq 'A') { $session.PSObject.Properties['client_a'].Value } else { $session.PSObject.Properties['client_b'].Value }
Assert-True ($clientObject -is [pscustomobject]) "SESSION_INFO is missing metadata for Client $Client."
$clientId = Get-RequiredString $clientObject 'id' "SESSION_INFO.client_$($Client.ToLowerInvariant())"
$clientCountry = Get-RequiredString $clientObject 'country' "SESSION_INFO.client_$($Client.ToLowerInvariant())"
$clientNetwork = Get-RequiredString $clientObject 'network' "SESSION_INFO.client_$($Client.ToLowerInvariant())"
$peerId = Get-RequiredString $session 'bootstrap_peer_id' 'SESSION_INFO'
$tcpBootstrap = Get-RequiredString $session 'tcp_bootstrap' 'SESSION_INFO'
$quicBootstrap = Get-RequiredString $session 'quic_bootstrap' 'SESSION_INFO'

$internetTest = Join-Path $PSScriptRoot 'internet-test.ps1'
Assert-True (Test-Path -LiteralPath $internetTest -PathType Leaf) "Required bootstrap validator is missing: $internetTest"
& $internetTest -Bootstrap $tcpBootstrap -ValidateOnly -RequirePublicHost -RequireDnsResolution | Out-Null
& $internetTest -Bootstrap $quicBootstrap -ValidateOnly -RequirePublicHost -RequireDnsResolution | Out-Null

Write-Host "Running exact-build authenticated TCP probe from Client $Client ($clientId)..." -ForegroundColor Cyan
$tcpProbe = Invoke-Netprobe -NetprobePath $netprobePath -Target $tcpBootstrap -Timeout $TimeoutSeconds
Write-Host "Running exact-build authenticated QUIC-v1 probe from Client $Client ($clientId)..." -ForegroundColor Cyan
$quicProbe = Invoke-Netprobe -NetprobePath $netprobePath -Target $quicBootstrap -Timeout $TimeoutSeconds

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $sessionDirectory ("client-{0}-netprobe.json" -f $Client.ToLowerInvariant())
}
$outputFullPath = [IO.Path]::GetFullPath($OutputPath)
Assert-True (-not (Test-Path -LiteralPath $outputFullPath)) "Client probe evidence already exists and will not be overwritten: $outputFullPath"
$outputDirectory = Split-Path $outputFullPath -Parent
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$evidence = [ordered]@{
    schema_version = 1
    created_utc = [DateTimeOffset]::UtcNow.ToString('o')
    product = 'Konofix Chat'
    client_role = $Client
    client_id = $clientId
    client_country = $clientCountry
    client_network = $clientNetwork
    build_version = $version
    source_commit = $commit
    build_info_sha256 = $actualBuildInfoHash
    session_info_sha256 = $actualSessionInfoHash
    netprobe_sha256 = $actualNetprobeHash
    bootstrap_peer_id = $peerId
    tcp_bootstrap = $tcpBootstrap
    quic_bootstrap = $quicBootstrap
    tcp_probe = $tcpProbe
    quic_probe = $quicProbe
}

$tempPath = "$outputFullPath.$([guid]::NewGuid().ToString('N')).tmp"
try {
    $evidence | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $tempPath -Encoding utf8
    Move-Item -LiteralPath $tempPath -Destination $outputFullPath
    $validator = Join-Path $PSScriptRoot 'validate-client-netprobe.ps1'
    Assert-True (Test-Path -LiteralPath $validator -PathType Leaf) "Client probe validator is missing: $validator"
    & $validator -Evidence $outputFullPath -SessionInfoPath $sessionInfoPath -BuildInfoPath $buildInfoPath | Out-Null
} catch {
    Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $outputFullPath -Force -ErrorAction SilentlyContinue
    throw
}

Write-Host "PASS - Client $Client authenticated the configured public Node over TCP and QUIC-v1." -ForegroundColor Green
Write-Host "Evidence: $outputFullPath"
Write-Host "Peer ID:  $peerId"
Write-Host "Netprobe: $actualNetprobeHash"
