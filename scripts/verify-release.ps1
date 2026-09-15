param(
  [string]$ZipPath = 'Konofix-Chat-0.4.2-test1-Windows.zip',
  [string]$ChecksumPath = 'Konofix-Chat-0.4.2-test1-Windows.zip.sha256'
)

$ErrorActionPreference = 'Stop'

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

Write-Host '=== Konofix Chat - RELEASE ARTIFACT VERIFY ===' -ForegroundColor Cyan

Assert-True (Test-Path $ZipPath) "Release archive is missing: $ZipPath"
Assert-True (Test-Path $ChecksumPath) "SHA-256 file is missing: $ChecksumPath"

$expected = ((Get-Content $ChecksumPath -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
Assert-True ($expected -match '^[0-9a-f]{64}$') 'Invalid SHA-256 format.'
Assert-True ($actual -eq $expected) "SHA-256 mismatch. expected=$expected actual=$actual"

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("konofix-release-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null
try {
  Expand-Archive -Path $ZipPath -DestinationPath $temp -Force

  $required = @(
    'konofix-node.exe',
    'README.md',
    'TESTING.md',
    'NODE.md',
    'RELEASE_NOTES.md'
  )
  foreach ($name in $required) {
    $path = Join-Path $temp $name
    Assert-True (Test-Path $path) "Release archive does not contain: $name"
    Assert-True ((Get-Item $path).Length -gt 0) "Release file is empty: $name"
  }

  $node = Join-Path $temp 'konofix-node.exe'
  Assert-True ((Get-Item $node).Length -gt 1MB) 'konofix-node.exe appears to be an incomplete build.'

  $bundle = Join-Path $temp 'bundle'
  Assert-True (Test-Path $bundle) 'Windows application bundle directory is missing.'
  $installers = @(Get-ChildItem $bundle -Recurse -File | Where-Object { $_.Extension -in '.exe', '.msi' })
  Assert-True ($installers.Count -gt 0) 'No .exe/.msi installer was found in the bundle.'
  foreach ($installer in $installers) {
    Assert-True ($installer.Length -gt 1MB) "Installer appears incomplete: $($installer.FullName)"
  }

  $releaseNotes = Get-Content (Join-Path $temp 'RELEASE_NOTES.md') -Raw
  Assert-True ($releaseNotes -match '0\.4\.2 Test 1') 'RELEASE_NOTES.md does not describe the expected test release.'

  Write-Host "OK - ZIP, SHA-256, Node, documentation and $($installers.Count) Windows installer(s) verified." -ForegroundColor Green
  Write-Host "SHA256: $actual"
} finally {
  if (Test-Path $temp) { Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue }
}
