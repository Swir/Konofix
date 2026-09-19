param(
  [Parameter(Mandatory = $true)]
  [string]$Version,

  [Parameter(Mandatory = $true)]
  [string]$Commit,

  [switch]$Checksum
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Version) -or $Version -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
  throw "Release version is not a safe SemVer-like value: '$Version'"
}

if ($Commit -cnotmatch '^[0-9a-f]{40}$') {
  throw "Release commit must be an exact lowercase 40-character Git SHA: '$Commit'"
}

$name = "Konofix-Chat-$Version-Windows-$Commit.zip"
if ($Checksum) {
  Write-Output "$name.sha256"
} else {
  Write-Output $name
}
