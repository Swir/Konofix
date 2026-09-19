$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'release-artifact-name.ps1'
$sha = '0123456789abcdef0123456789abcdef01234567'

function Assert-Equal([string]$Actual, [string]$Expected, [string]$Label) {
  if (-not [string]::Equals($Actual, $Expected, [System.StringComparison]::Ordinal)) {
    throw "$Label mismatch. expected=$Expected actual=$Actual"
  }
}

function Expect-Failure([string]$Label, [scriptblock]$Action, [string]$ExpectedPattern) {
  $failed = $false
  try {
    & $Action | Out-Null
  } catch {
    if ($_.Exception.Message -notmatch $ExpectedPattern) {
      throw "$Label failed for an unexpected reason: $($_.Exception.Message)"
    }
    $failed = $true
  }
  if (-not $failed) { throw "$Label unexpectedly succeeded." }
}

$name = & $helper -Version '0.4.2' -Commit $sha
Assert-Equal $name "Konofix-Chat-0.4.2-Windows-$sha.zip" 'stable archive name'

$checksum = & $helper -Version '0.4.2' -Commit $sha -Checksum
Assert-Equal $checksum "Konofix-Chat-0.4.2-Windows-$sha.zip.sha256" 'checksum name'

$pre = & $helper -Version '0.4.3-rc.1+build.7' -Commit $sha
Assert-Equal $pre "Konofix-Chat-0.4.3-rc.1+build.7-Windows-$sha.zip" 'prerelease archive name'

Expect-Failure 'short SHA' { & $helper -Version '0.4.2' -Commit '01234567' } '40-character Git SHA'
Expect-Failure 'uppercase SHA' { & $helper -Version '0.4.2' -Commit '0123456789ABCDEF0123456789ABCDEF01234567' } '40-character Git SHA'
Expect-Failure 'unsafe version path' { & $helper -Version '../0.4.2' -Commit $sha } 'safe SemVer-like value'
Expect-Failure 'unsafe version separator' { & $helper -Version '0.4.2/test' -Commit $sha } 'safe SemVer-like value'

Write-Host 'Release artifact naming self-tests passed.' -ForegroundColor Green
