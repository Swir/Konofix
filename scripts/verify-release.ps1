param(
  [string]$ZipPath = 'Konofix-Chat-0.4.2-test1-Windows.zip',
  [string]$ChecksumPath = 'Konofix-Chat-0.4.2-test1-Windows.zip.sha256'
)

$ErrorActionPreference = 'Stop'

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

Write-Host '=== Konofix Chat - RELEASE ARTIFACT VERIFY ===' -ForegroundColor Cyan

Assert-True (Test-Path $ZipPath) "Brak archiwum release: $ZipPath"
Assert-True (Test-Path $ChecksumPath) "Brak pliku SHA-256: $ChecksumPath"

$expected = ((Get-Content $ChecksumPath -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
Assert-True ($expected -match '^[0-9a-f]{64}$') 'Nieprawidłowy format SHA-256.'
Assert-True ($actual -eq $expected) "SHA-256 nie zgadza się. expected=$expected actual=$actual"

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
    Assert-True (Test-Path $path) "Archiwum release nie zawiera: $name"
    Assert-True ((Get-Item $path).Length -gt 0) "Plik w release jest pusty: $name"
  }

  $node = Join-Path $temp 'konofix-node.exe'
  Assert-True ((Get-Item $node).Length -gt 1MB) 'konofix-node.exe wygląda na niepełny build.'

  $bundle = Join-Path $temp 'bundle'
  Assert-True (Test-Path $bundle) 'Brak katalogu bundle aplikacji Windows.'
  $installers = @(Get-ChildItem $bundle -Recurse -File | Where-Object { $_.Extension -in '.exe', '.msi' })
  Assert-True ($installers.Count -gt 0) 'Nie znaleziono instalatora .exe/.msi w bundle.'
  foreach ($installer in $installers) {
    Assert-True ($installer.Length -gt 1MB) "Instalator wygląda na niepełny: $($installer.FullName)"
  }

  $releaseNotes = Get-Content (Join-Path $temp 'RELEASE_NOTES.md') -Raw
  Assert-True ($releaseNotes -match '0\.4\.2 Test 1') 'RELEASE_NOTES.md nie opisuje oczekiwanego test-release.'

  Write-Host "OK - ZIP, SHA-256, Node, dokumentacja i $($installers.Count) instalator(y) Windows zweryfikowane." -ForegroundColor Green
  Write-Host "SHA256: $actual"
} finally {
  if (Test-Path $temp) { Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue }
}
