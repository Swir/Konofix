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

  $toolRelativePaths = @(
    'scripts\internet-test.ps1',
    'scripts\public-node.ps1',
    'scripts\install-public-node-task.ps1',
    'scripts\check-public-node-readiness.ps1',
    'scripts\new-network-test-session.ps1',
    'scripts\new-network-test-report.ps1',
    'scripts\set-network-test-result.ps1',
    'scripts\validate-network-test-report.ps1',
    'scripts\validate-network-test-session.ps1',
    'scripts\check-promotion-evidence.ps1',
    'scripts\check-node-health.ps1',
    'scripts\collect-node-soak.ps1',
    'scripts\validate-node-soak.ps1'
  )
  $required = @(
    'konofix-node.exe',
    'README.md',
    'TESTING.md',
    'NODE.md',
    'NODE_SOAK.md',
    'RELEASE_NOTES.md',
    'BUILD_INFO.json',
    'package-lock.json',
    'Cargo.lock'
  ) + $toolRelativePaths
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

  $toolFiles = @($toolRelativePaths | ForEach-Object { Get-Item (Join-Path $temp $_) })
  Assert-True ($toolFiles.Count -eq $toolRelativePaths.Count) 'The release archive does not contain the complete test-tool set.'

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

  $frontendLock = Join-Path $temp 'package-lock.json'
  $frontendLockMeta = $buildInfo.frontend_lock
  Assert-True ($null -ne $frontendLockMeta) 'BUILD_INFO.json is missing frontend lock metadata.'
  Assert-True ([string]::Equals([string]$frontendLockMeta.path, 'package-lock.json', [System.StringComparison]::Ordinal)) 'BUILD_INFO.json package-lock.json path is invalid.'
  Assert-True ([int64]$frontendLockMeta.bytes -eq [int64](Get-Item $frontendLock).Length) 'BUILD_INFO.json package-lock.json size does not match the archive.'
  Assert-Hash -Path $frontendLock -Expected ([string]$frontendLockMeta.sha256) -Label 'package-lock.json'

  $repoFrontendLock = Join-Path $repoRoot 'package-lock.json'
  Assert-True (Test-Path $repoFrontendLock -PathType Leaf) 'Repository package-lock.json is missing during artifact verification.'
  Assert-True ([int64](Get-Item $repoFrontendLock).Length -eq [int64](Get-Item $frontendLock).Length) 'Packaged package-lock.json size does not match the committed build input.'
  $repoFrontendLockHash = (Get-FileHash $repoFrontendLock -Algorithm SHA256).Hash.ToLowerInvariant()
  Assert-True ([string]::Equals($repoFrontendLockHash, [string]$frontendLockMeta.sha256, [System.StringComparison]::Ordinal)) 'Packaged package-lock.json does not match the committed build input.'

  $cargoLock = Join-Path $temp 'Cargo.lock'
  $lockMeta = $buildInfo.rust_lock
  Assert-True ($null -ne $lockMeta) 'BUILD_INFO.json is missing Rust lock metadata.'
  Assert-True ([string]::Equals([string]$lockMeta.path, 'Cargo.lock', [System.StringComparison]::Ordinal)) 'BUILD_INFO.json Cargo.lock path is invalid.'
  Assert-True ([int64]$lockMeta.bytes -eq [int64](Get-Item $cargoLock).Length) 'BUILD_INFO.json Cargo.lock size does not match the archive.'
  Assert-Hash -Path $cargoLock -Expected ([string]$lockMeta.sha256) -Label 'Cargo.lock'

  $repoCargoLock = Join-Path $repoRoot 'src-tauri\Cargo.lock'
  Assert-True (Test-Path $repoCargoLock -PathType Leaf) 'Committed repository src-tauri\Cargo.lock is missing during artifact verification.'
  Assert-True ([int64](Get-Item $repoCargoLock).Length -eq [int64](Get-Item $cargoLock).Length) 'Packaged Cargo.lock size does not match the committed Rust build input.'
  $repoCargoLockHash = (Get-FileHash $repoCargoLock -Algorithm SHA256).Hash.ToLowerInvariant()
  Assert-True ([string]::Equals($repoCargoLockHash, [string]$lockMeta.sha256, [System.StringComparison]::Ordinal)) 'Packaged Cargo.lock does not match the committed Rust build input.'

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

  $toolMetadata = @($buildInfo.tools)
  Assert-True ($toolMetadata.Count -eq $toolFiles.Count) "BUILD_INFO.json test-tool count mismatch. metadata=$($toolMetadata.Count) archive=$($toolFiles.Count)"
  foreach ($tool in $toolFiles) {
    $relative = [IO.Path]::GetRelativePath($temp, $tool.FullName).Replace('\', '/')
    $matches = @($toolMetadata | Where-Object { ([string]$_.path) -ceq $relative })
    Assert-True ($matches.Count -eq 1) "BUILD_INFO.json must contain exactly one entry for test tool: $relative"
    $meta = $matches[0]
    Assert-True ([int64]$meta.bytes -eq [int64]$tool.Length) "Test-tool size mismatch for $relative"
    Assert-Hash -Path $tool.FullName -Expected ([string]$meta.sha256) -Label "Test tool $relative"
  }

  $releaseNotes = Get-Content (Join-Path $temp 'RELEASE_NOTES.md') -Raw
  Assert-True ($releaseNotes -match '0\.4\.2 Test 1') 'RELEASE_NOTES.md does not describe the expected test release.'

  Write-Host "OK - ZIP, provenance metadata, Node, committed frontend/Rust dependency inputs, $($toolFiles.Count) test tools, documentation and $($installers.Count) Windows installer(s) verified." -ForegroundColor Green
  Write-Host "SHA256: $actual"
  Write-Host "Build commit: $commit"
} finally {
  if (Test-Path $temp) { Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue }
}
