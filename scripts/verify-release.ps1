param(
  [string]$ZipPath = 'Konofix-Chat-0.4.2-test1-Windows.zip',
  [string]$ChecksumPath = 'Konofix-Chat-0.4.2-test1-Windows.zip.sha256'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Assert-Hash([string]$Path, [string]$Expected, [string]$Label) {
  Assert-True ($Expected -match '^[0-9a-f]{64}$') "$Label metadata contains an invalid SHA-256 value."
  $actualHash = (Get-FileHash $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  Assert-True ([string]::Equals($actualHash, $Expected, [System.StringComparison]::Ordinal)) "$Label SHA-256 mismatch. expected=$Expected actual=$actualHash"
}

Write-Host '=== Konofix Chat - RELEASE ARTIFACT VERIFY ===' -ForegroundColor Cyan

Assert-True (Test-Path $ZipPath -PathType Leaf) "Release archive is missing: $ZipPath"
Assert-True (Test-Path $ChecksumPath -PathType Leaf) "SHA-256 file is missing: $ChecksumPath"

$expected = ((Get-Content $ChecksumPath -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
Assert-True ($expected -match '^[0-9a-f]{64}$') 'Invalid SHA-256 format.'
Assert-True ([string]::Equals($actual, $expected, [System.StringComparison]::Ordinal)) "SHA-256 mismatch. expected=$expected actual=$actual"

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("konofix-release-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null
try {
  Expand-Archive -Path $ZipPath -DestinationPath $temp -Force

  $required = @(
    'konofix-node.exe',
    'README.md',
    'TESTING.md',
    'NODE.md',
    'NODE_SOAK.md',
    'RELEASE_NOTES.md',
    'BUILD_INFO.json',
    'Cargo.lock'
  )
  foreach ($name in $required) {
    $path = Join-Path $temp $name
    Assert-True (Test-Path $path -PathType Leaf) "Release archive does not contain: $name"
    Assert-True ((Get-Item $path).Length -gt 0) "Release file is empty: $name"
  }

  $node = Join-Path $temp 'konofix-node.exe'
  Assert-True ((Get-Item $node).Length -gt 1MB) 'konofix-node.exe appears to be an incomplete build.'

  $bundle = Join-Path $temp 'bundle'
  Assert-True (Test-Path $bundle -PathType Container) 'Windows application bundle directory is missing.'
  $installers = @(Get-ChildItem $bundle -Recurse -File | Where-Object { $_.Extension -in @('.exe', '.msi') })
  Assert-True ($installers.Count -gt 0) 'No .exe/.msi installer was found in the bundle.'
  foreach ($installer in $installers) {
    Assert-True ($installer.Length -gt 1MB) "Installer appears incomplete: $($installer.FullName)"
  }

  $buildInfoPath = Join-Path $temp 'BUILD_INFO.json'
  try { $buildInfo = Get-Content $buildInfoPath -Raw | ConvertFrom-Json } catch { throw "BUILD_INFO.json is not valid JSON: $($_.Exception.Message)" }
  Assert-True ([int]$buildInfo.schema -eq 1) 'BUILD_INFO.json uses an unsupported schema.'
  Assert-True ([string]::Equals([string]$buildInfo.product, 'Konofix Chat', [System.StringComparison]::Ordinal)) 'BUILD_INFO.json contains the wrong product name.'

  $package = Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
  $expectedVersion = [string]$package.version
  Assert-True ([string]::Equals([string]$buildInfo.version, $expectedVersion, [System.StringComparison]::Ordinal)) "BUILD_INFO.json version mismatch. expected=$expectedVersion actual=$($buildInfo.version)"

  $commit = [string]$buildInfo.commit
  Assert-True ($commit -match '^[0-9a-f]{40}$') 'BUILD_INFO.json commit is not a full Git SHA.'
  if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_SHA)) {
    Assert-True ([string]::Equals($commit, [string]$env:GITHUB_SHA, [System.StringComparison]::Ordinal)) "BUILD_INFO.json commit does not match the workflow commit. expected=$env:GITHUB_SHA actual=$commit"
  }

  $nodeMeta = $buildInfo.node
  Assert-True ($null -ne $nodeMeta) 'BUILD_INFO.json is missing Node metadata.'
  Assert-True ([string]::Equals([string]$nodeMeta.path, 'konofix-node.exe', [System.StringComparison]::Ordinal)) 'BUILD_INFO.json Node path is invalid.'
  Assert-True ([int64]$nodeMeta.bytes -eq [int64](Get-Item $node).Length) 'BUILD_INFO.json Node size does not match the archive.'
  Assert-Hash -Path $node -Expected ([string]$nodeMeta.sha256) -Label 'Konofix Node'

  $cargoLock = Join-Path $temp 'Cargo.lock'
  $lockMeta = $buildInfo.rust_lock
  Assert-True ($null -ne $lockMeta) 'BUILD_INFO.json is missing Rust lock metadata.'
  Assert-True ([string]::Equals([string]$lockMeta.path, 'Cargo.lock', [System.StringComparison]::Ordinal)) 'BUILD_INFO.json Cargo.lock path is invalid.'
  Assert-True ([int64]$lockMeta.bytes -eq [int64](Get-Item $cargoLock).Length) 'BUILD_INFO.json Cargo.lock size does not match the archive.'
  Assert-Hash -Path $cargoLock -Expected ([string]$lockMeta.sha256) -Label 'Cargo.lock'

  $installerMetadata = @($buildInfo.installers)
  Assert-True ($installerMetadata.Count -eq $installers.Count) "BUILD_INFO.json installer count mismatch. metadata=$($installerMetadata.Count) archive=$($installers.Count)"
  foreach ($installer in $installers) {
    $relative = [IO.Path]::GetRelativePath($temp, $installer.FullName).Replace('\', '/')
    $matches = @($installerMetadata | Where-Object { ([string]$_.path) -ceq $relative })
    Assert-True ($matches.Count -eq 1) "BUILD_INFO.json must contain exactly one entry for installer: $relative"
    $meta = $matches[0]
    Assert-True ([int64]$meta.bytes -eq [int64]$installer.Length) "Installer size mismatch for $relative"
    Assert-Hash -Path $installer.FullName -Expected ([string]$meta.sha256) -Label "Installer $relative"
  }

  $releaseNotes = Get-Content (Join-Path $temp 'RELEASE_NOTES.md') -Raw
  Assert-True ($releaseNotes -match '0\.4\.2 Test 1') 'RELEASE_NOTES.md does not describe the expected test release.'

  Write-Host "OK - ZIP, provenance metadata, Node, Cargo resolution record, documentation and $($installers.Count) Windows installer(s) verified." -ForegroundColor Green
  Write-Host "SHA256: $actual"
  Write-Host "Build commit: $commit"
} finally {
  if (Test-Path $temp) { Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue }
}
