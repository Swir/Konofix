param(
  [string]$ZipPath = 'Konofix-Chat-0.4.2-test1-Windows.zip',
  [string]$ChecksumPath = 'Konofix-Chat-0.4.2-test1-Windows.zip.sha256'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$MaxZipArchiveBytes = [int64](1GB)
$MaxZipEntries = 8192
$MaxZipEntryBytes = [int64](1GB)
$MaxZipExpandedBytes = [int64](2GB)
$MaxZipCompressionRatio = 500.0
$MinZipRatioCheckBytes = [int64](1MB)
$MaxBuildInfoBytes = [int64](2MB)
$MaxChecksumBytes = [int64](1KB)
$WindowsReservedDeviceNamePattern = '^(?i:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])$'

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Assert-Hash([string]$Path, [string]$Expected, [string]$Label) {
  Assert-True ($Expected -match '^[0-9a-f]{64}$') "$Label metadata contains an invalid SHA-256 value."
  $actualHash = (Get-FileHash $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  Assert-True ([string]::Equals($actualHash, $Expected, [System.StringComparison]::Ordinal)) "$Label SHA-256 mismatch. expected=$Expected actual=$actualHash"
}

function Assert-SafeRelativePath([string]$PathValue, [string]$Label) {
  Assert-True (-not [string]::IsNullOrWhiteSpace($PathValue)) "$Label path is empty."
  Assert-True ($PathValue.Length -le 512) "$Label path is too long: $PathValue"
  Assert-True (-not $PathValue.Contains('\')) "$Label path must use forward slashes only: $PathValue"
  Assert-True (-not $PathValue.StartsWith('/')) "$Label path must be relative: $PathValue"
  Assert-True ($PathValue -notmatch '^[A-Za-z]:') "$Label path must not contain a drive prefix: $PathValue"
  Assert-True (-not $PathValue.Contains(':')) "$Label path contains a disallowed colon: $PathValue"
  $segments = @($PathValue -split '/')
  Assert-True ($segments.Count -gt 0) "$Label path has no segments: $PathValue"
  Assert-True (-not ($segments | Where-Object { [string]::IsNullOrWhiteSpace($_) -or $_ -eq '.' -or $_ -eq '..' })) "$Label path contains an unsafe or parent-directory segment: $PathValue"
  foreach ($segment in $segments) {
    Assert-True ($segment -notmatch '[\x00-\x1f\x7f]') "$Label path contains a control character: $PathValue"
    Assert-True ($segment -notmatch '[\. ]$') "$Label path segment ends with a Windows-aliased dot or space: $PathValue"
    $deviceStem = @($segment -split '\.', 2)[0]
    Assert-True ($deviceStem -notmatch $WindowsReservedDeviceNamePattern) "$Label path uses a reserved Windows device name: $PathValue"
  }
}

function Read-ReleaseChecksum([string]$Path, [string]$ArchivePath) {
  $checksumItem = Get-Item -LiteralPath $Path
  Assert-True ([int64]$checksumItem.Length -gt 0) 'SHA-256 file is empty.'
  Assert-True ([int64]$checksumItem.Length -le $MaxChecksumBytes) "SHA-256 file is unexpectedly large. bytes=$($checksumItem.Length) max=$MaxChecksumBytes"
  $text = (Get-Content -LiteralPath $Path -Raw).Trim()
  $match = [regex]::Match($text, '^([0-9a-f]{64}) [ *]([^\r\n]+)$', [System.Text.RegularExpressions.RegexOptions]::CultureInvariant)
  Assert-True ($match.Success) 'SHA-256 file has an invalid format; expected exactly one lowercase SHA-256 and archive filename.'
  $recordedName = $match.Groups[2].Value
  $archiveName = [IO.Path]::GetFileName((Resolve-Path -LiteralPath $ArchivePath).Path)
  Assert-True ([string]::Equals($recordedName, $archiveName, [System.StringComparison]::Ordinal)) "SHA-256 file names a different archive. expected=$archiveName actual=$recordedName"
  return $match.Groups[1].Value
}

function Assert-SafeZipEntries([string]$ArchivePath) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archiveFull = (Resolve-Path $ArchivePath).Path
  $archiveFile = Get-Item -LiteralPath $archiveFull
  Assert-True ([int64]$archiveFile.Length -le $MaxZipArchiveBytes) "ZIP archive is too large for safe verification. bytes=$($archiveFile.Length) max=$MaxZipArchiveBytes"

  $archive = [System.IO.Compression.ZipFile]::OpenRead($archiveFull)
  $seenEntries = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $expandedBytes = [int64]0
  try {
    Assert-True ($archive.Entries.Count -le $MaxZipEntries) "ZIP contains too many entries. entries=$($archive.Entries.Count) max=$MaxZipEntries"
    foreach ($entry in $archive.Entries) {
      $raw = [string]$entry.FullName
      Assert-True (-not [string]::IsNullOrWhiteSpace($raw)) 'ZIP contains an unnamed entry.'
      $normalized = $raw.Replace('\', '/').TrimEnd('/')
      if ([string]::IsNullOrWhiteSpace($normalized)) { continue }
      Assert-SafeRelativePath -PathValue $normalized -Label 'ZIP entry'
      Assert-True ($seenEntries.Add($normalized)) "ZIP contains a duplicate/case-colliding entry: $normalized"

      $entryLength = [int64]$entry.Length
      $compressedLength = [int64]$entry.CompressedLength
      Assert-True ($entryLength -ge 0) "ZIP entry reports a negative expanded size: $normalized"
      Assert-True ($compressedLength -ge 0) "ZIP entry reports a negative compressed size: $normalized"
      Assert-True ($entryLength -le $MaxZipEntryBytes) "ZIP entry exceeds the expanded per-file limit: $normalized bytes=$entryLength max=$MaxZipEntryBytes"
      if ([string]::Equals($normalized, 'BUILD_INFO.json', [System.StringComparison]::OrdinalIgnoreCase)) {
        Assert-True ($entryLength -le $MaxBuildInfoBytes) "BUILD_INFO.json exceeds the bounded metadata size. bytes=$entryLength max=$MaxBuildInfoBytes"
      }
      Assert-True ($expandedBytes -le ($MaxZipExpandedBytes - $entryLength)) "ZIP expanded size exceeds the verification budget. next=$normalized total_limit=$MaxZipExpandedBytes"
      $expandedBytes += $entryLength

      if ($entryLength -ge $MinZipRatioCheckBytes) {
        Assert-True ($compressedLength -gt 0) "ZIP entry has an invalid zero compressed size: $normalized"
        $ratio = [double]$entryLength / [double]$compressedLength
        Assert-True ($ratio -le $MaxZipCompressionRatio) "ZIP entry compression ratio exceeds the verification budget: $normalized ratio=$([Math]::Round($ratio, 2)) max=$MaxZipCompressionRatio"
      }
    }
  } finally {
    $archive.Dispose()
  }
}

Write-Host '=== Konofix Chat - RELEASE ARTIFACT VERIFY ===' -ForegroundColor Cyan

Assert-True (Test-Path $ZipPath -PathType Leaf) "Release archive is missing: $ZipPath"
Assert-True (Test-Path $ChecksumPath -PathType Leaf) "SHA-256 file is missing: $ChecksumPath"

$expected = Read-ReleaseChecksum -Path $ChecksumPath -ArchivePath $ZipPath
$actual = (Get-FileHash $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
Assert-True ([string]::Equals($actual, $expected, [System.StringComparison]::Ordinal)) "SHA-256 mismatch. expected=$expected actual=$actual"

# Inspect entry names and resource budgets before extraction so a re-hashed archive cannot use
# path traversal, duplicate names or a decompression bomb against the verification workspace.
Assert-SafeZipEntries -ArchivePath $ZipPath

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
    'scripts\test-node-runtime.ps1',
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
  Assert-True ([int]$buildInfo.schema -eq 2) 'BUILD_INFO.json uses an unsupported schema; complete inventory schema 2 is required.'
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
  Assert-True ([string]::Equals($repoCargoLockHash, [string]$lockMeta.sha256, [System.StringComparison]::Ordinal)) 'Packaged Cargo.lock.json does not match the committed Rust build input.'

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

  # Schema 2 seals every regular file in the staged Windows bundle except BUILD_INFO.json
  # itself (which cannot hash itself without recursion). This catches tampered docs, extra
  # executables, missing files, and any bundle content not covered by the older selective fields.
  $inventoryMetadata = @($buildInfo.files)
  Assert-True ($inventoryMetadata.Count -gt 0) 'BUILD_INFO.json complete file inventory is missing.'
  $seenMetadata = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $tempFull = [System.IO.Path]::GetFullPath($temp).TrimEnd([char[]]@('\', '/'))
  $tempPrefix = $tempFull + [System.IO.Path]::DirectorySeparatorChar

  foreach ($meta in $inventoryMetadata) {
    $relative = [string]$meta.path
    Assert-SafeRelativePath -PathValue $relative -Label 'BUILD_INFO inventory'
    Assert-True (-not [string]::Equals($relative, 'BUILD_INFO.json', [System.StringComparison]::OrdinalIgnoreCase)) 'BUILD_INFO.json must not appear in its own complete inventory.'
    Assert-True ($seenMetadata.Add($relative)) "BUILD_INFO.json contains a duplicate/case-colliding inventory path: $relative"
    Assert-True ([int64]$meta.bytes -ge 0) "BUILD_INFO inventory contains a negative byte length: $relative"

    $candidate = Join-Path $temp ($relative.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
    $candidateFull = [System.IO.Path]::GetFullPath($candidate)
    Assert-True ($candidateFull.StartsWith($tempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) "BUILD_INFO inventory path escapes the extraction root: $relative"
    Assert-True (Test-Path $candidateFull -PathType Leaf) "Complete bundle inventory references a missing file: $relative"
    Assert-True ([int64]$meta.bytes -eq [int64](Get-Item $candidateFull).Length) "Complete bundle inventory size mismatch: $relative"
    Assert-Hash -Path $candidateFull -Expected ([string]$meta.sha256) -Label "Bundle file $relative"
  }

  $actualFiles = @(Get-ChildItem $temp -Recurse -File | Where-Object {
    $relative = [IO.Path]::GetRelativePath($temp, $_.FullName).Replace('\', '/')
    -not [string]::Equals($relative, 'BUILD_INFO.json', [System.StringComparison]::OrdinalIgnoreCase)
  })
  Assert-True ($actualFiles.Count -eq $inventoryMetadata.Count) "Complete bundle inventory count mismatch. metadata=$($inventoryMetadata.Count) archive=$($actualFiles.Count)"
  foreach ($file in $actualFiles) {
    $relative = [IO.Path]::GetRelativePath($temp, $file.FullName).Replace('\', '/')
    Assert-True ($seenMetadata.Contains($relative)) "Release archive contains a file missing from the sealed inventory: $relative"
  }

  $releaseNotes = Get-Content (Join-Path $temp 'RELEASE_NOTES.md') -Raw
  Assert-True ($releaseNotes -match '0\.4\.2 Test 1') 'RELEASE_NOTES.md does not describe the expected test release.'

  Write-Host "OK - ZIP safety budgets, complete sealed file inventory, provenance metadata, Node, committed frontend/Rust dependency inputs, $($toolFiles.Count) test tools, documentation and $($installers.Count) Windows installer(s) verified." -ForegroundColor Green
  Write-Host "SHA256: $actual"
  Write-Host "Build commit: $commit"
} finally {
  if (Test-Path $temp) { Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue }
}