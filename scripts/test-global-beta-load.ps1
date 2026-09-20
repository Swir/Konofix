$ErrorActionPreference = 'Stop'

$scriptUnderTest = Join-Path $PSScriptRoot 'global-beta-load.ps1'
if (-not (Test-Path -LiteralPath $scriptUnderTest -PathType Leaf)) {
  throw "Missing global beta load script: $scriptUnderTest"
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ("konofix-global-beta-load-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null

try {
  $passProbe = Join-Path $temp 'pass-probe.cmd'
  $failProbe = Join-Path $temp 'fail-probe.cmd'
  @'
@echo off
echo {"status":"pass","rtt_micros":1000,"elapsed_millis":5}
exit /b 0
'@ | Set-Content -LiteralPath $passProbe -Encoding ascii
  @'
@echo off
echo simulated probe failure 1>&2
exit /b 7
'@ | Set-Content -LiteralPath $failProbe -Encoding ascii

  $tcp = '/ip4/127.0.0.1/tcp/45555/p2p/12D3KooWGlobalBetaTestPeer'
  $quic = '/ip4/127.0.0.1/udp/45555/quic-v1/p2p/12D3KooWGlobalBetaTestPeer'
  $output = Join-Path $temp 'summary.json'

  $jsonText = & $scriptUnderTest -TcpBootstrap $tcp -QuicBootstrap $quic -Clients 8 -Parallelism 3 -TimeoutSeconds 5 -MinimumSuccessPercent 100 -NetprobePath $passProbe -OutputPath $output
  $summary = ($jsonText -join [Environment]::NewLine) | ConvertFrom-Json
  if ($summary.status -cne 'pass') { throw 'Expected successful load summary.' }
  if ([int]$summary.clients -ne 8 -or [int]$summary.passed -ne 8 -or [int]$summary.failed -ne 0) {
    throw 'Successful load summary has incorrect counts.'
  }
  if ([int]$summary.tcp.attempted -ne 4 -or [int]$summary.quic.attempted -ne 4) {
    throw 'Mixed TCP/QUIC scheduling is not balanced as expected.'
  }
  if (-not (Test-Path -LiteralPath $output -PathType Leaf)) {
    throw 'Expected output JSON was not written.'
  }

  $rejected = $false
  try {
    & $scriptUnderTest -TcpBootstrap $tcp -Clients 4 -Parallelism 2 -TimeoutSeconds 5 -MinimumSuccessPercent 100 -NetprobePath $failProbe | Out-Null
  } catch {
    if ($_.Exception.Message -notmatch 'all TCP probes failed|success rate') {
      throw "Unexpected failure reason from failing probe fixture: $($_.Exception.Message)"
    }
    $rejected = $true
  }
  if (-not $rejected) { throw 'Failing probe fixture was unexpectedly accepted.' }

  $missingRejected = $false
  try {
    & $scriptUnderTest -TcpBootstrap $tcp -Clients 1 -NetprobePath (Join-Path $temp 'missing.exe') | Out-Null
  } catch {
    if ($_.Exception.Message -notmatch 'was not found') {
      throw "Unexpected missing-probe error: $($_.Exception.Message)"
    }
    $missingRejected = $true
  }
  if (-not $missingRejected) { throw 'Missing Netprobe path was unexpectedly accepted.' }

  Write-Host 'Global beta load harness self-tests passed.'
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
