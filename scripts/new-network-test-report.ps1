param(
    [Parameter(Mandatory = $true)][ValidateSet('LAN','TCP','QUIC','Relay','DCUtR','CGNAT')][string]$Scenario,
    [Parameter(Mandatory = $true)][string]$ClientA,
    [Parameter(Mandatory = $true)][string]$ClientB,
    [Parameter(Mandatory = $true)][string]$Bootstrap,
    [string]$OutputDirectory = 'test-results',
    [string]$Notes = ''
)

$ErrorActionPreference = 'Stop'

if ($Bootstrap -notmatch '^/(ip4|ip6|dns|dns4|dns6)/.+/p2p/[A-Za-z0-9]+$') {
    throw 'Bootstrap must be a complete libp2p multiaddress ending in /p2p/<PeerId>.'
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$stamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss')
$path = Join-Path $OutputDirectory "network-test-$($Scenario.ToLowerInvariant())-$stamp.md"

$body = @"
# Konofix Network Test Report

- UTC: $([DateTimeOffset]::UtcNow.ToString('u'))
- Scenario: $Scenario
- Client A: $ClientA
- Client B: $ClientB
- Bootstrap: ``$Bootstrap``
- Notes: $Notes

## Preconditions

- [ ] Windows build version recorded
- [ ] Public Node health check passed
- [ ] Bootstrap precheck passed from Client A
- [ ] Bootstrap precheck passed from Client B
- [ ] Node Peer ID is stable after restart

## Results

| Check | Result | Evidence / notes |
| --- | --- | --- |
| A -> B #WORLD message | PENDING | |
| B -> A #WORLD message | PENDING | |
| Room discovery | PENDING | |
| A -> B file + SHA-256 | PENDING | |
| B -> A file + SHA-256 | PENDING | |
| Client reconnect | PENDING | |
| Node restart recovery | PENDING | |
| Relay observed | PENDING | |
| DCUtR/direct upgrade observed | PENDING | |
| Nickname conflict handling | PENDING | |

## Outcome

Overall: **PENDING**

Record PASS/FAIL and enough evidence to reproduce failures. Do not include identity keys, tokens, private addresses, or other secrets.
"@

Set-Content -LiteralPath $path -Value $body -Encoding UTF8
Write-Host "Created network test report: $path"
