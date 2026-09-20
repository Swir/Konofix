$ErrorActionPreference = 'Stop'

$scriptUnderTest = Join-Path $PSScriptRoot 'global-beta-load.ps1'
if (-not (Test-Path -LiteralPath $scriptUnderTest -PathType Leaf)) {
  throw "Missing global beta load script: $scriptUnderTest"
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ("konofix-global-beta-load-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null

try {
  $passProbe = Join-Path $temp 'pass-probe.cmd'
  $wrongCommitProbe = Join-Path $temp 'wrong-commit-probe.cmd'
  $failProbe = Join-Path $temp 'fail-probe.cmd'
  @'
@echo off
set TRANSPORT=tcp
echo %3 | findstr /c:"/quic-v1/" >nul && set TRANSPORT=quic-v1
echo {"schema":1,"status":"pass","tool":"konofix-netprobe","version":"0.4.2","source_commit":"1111111111111111111111111111111111111111","transport":"%TRANSPORT%","target":"%3","expected_peer_id":"12D3KooWGlobalBetaTestPeer","observed_peer_id":"12D3KooWGlobalBetaTestPeer","rtt_micros":1000,"elapsed_millis":5}
exit /b 0
'@ | Set-Content -LiteralPath $passProbe -Encoding ascii
  @'
@echo off
set TRANSPORT=tcp
echo %3 | findstr /c:"/quic-v1/" >nul && set TRANSPORT=quic-v1
echo {"schema":1,"status":"pass","tool":"konofix-netprobe","version":"0.4.2","source_commit":"2222222222222222222222222222222222222222","transport":"%TRANSPORT%","target":"%3","expected_peer_id":"12D3KooWGlobalBetaTestPeer","observed_peer_id":"12D3KooWGlobalBetaTestPeer","rtt_micros":1000,"elapsed_millis":5}
exit /b 0
'@ | Set-Content -LiteralPath $wrongCommitProbe -Encoding ascii
  @'
@echo off
echo simulated probe failure 1>&2
exit /b 7
'@ | Set-Content -LiteralPath $failProbe -Encoding ascii

  $cmd = [Environment]::GetEnvironmentVariable('ComSpec')
  if ([string]::IsNullOrWhiteSpace($cmd) -or -not (Test-Path -LiteralPath $cmd -PathType Leaf)) {
    throw 'ComSpec/cmd.exe is required for the deterministic process fixture.'
  }

  $tcp = '/ip4/127.0.0.1/tcp/45555/p2p/12D3KooWGlobalBetaTestPeer'
  $quic = '/ip4/127.0.0.1/udp/45555/quic-v1/p2p/12D3KooWGlobalBetaTestPeer'
  $sourceCommit = '1111111111111111111111111111111111111111'
  $output = Join-Path $temp 'summary.json'

  $jsonText = & $scriptUnderTest -TcpBootstrap $tcp -QuicBootstrap $quic -Clients 8 -Parallelism 3 -TimeoutSeconds 5 -MinimumSuccessPercent 100 -NetprobePath $cmd -NetprobePrefixArguments @('/d', '/c', $passProbe) -ExpectedVersion '0.4.2' -ExpectedSourceCommit $sourceCommit -OutputPath $output
  $summary = ($jsonText -join [Environment]::NewLine) | ConvertFrom-Json
  if ($summary.status -cne 'pass') { throw 'Expected successful load summary.' }
  if ([int]$summary.schema -ne 2) { throw 'Expected schema-2 load summary.' }
  if ([int]$summary.clients -ne 8 -or [int]$summary.passed -ne 8 -or [int]$summary.failed -ne 0) {
    throw 'Successful load summary has incorrect counts.'
  }
  if ([int]$summary.tcp.attempted -ne 4 -or [int]$summary.quic.attempted -ne 4) {
    throw 'Mixed TCP/QUIC scheduling is not balanced as expected.'
  }
  if ([string]$summary.exact_build.version -cne '0.4.2' -or [string]$summary.exact_build.source_commit -cne $sourceCommit) {
    throw 'Exact-build identity was not preserved in the load summary.'
  }
  if ([string]$summary.exact_build.netprobe_sha256 -cnotmatch '^[0-9a-f]{64}$' -or [int64]$summary.exact_build.netprobe_bytes -le 0) {
    throw 'Netprobe artifact identity is missing from the load summary.'
  }
  if ([bool]$summary.node_health.verified) {
    throw 'Node health must remain unverified when no HealthPath was supplied.'
  }
  if (-not (Test-Path -LiteralPath $output -PathType Leaf)) {
    throw 'Expected output JSON was not written.'
  }

  $wrongCommitRejected = $false
  try {
    & $scriptUnderTest -TcpBootstrap $tcp -Clients 2 -Parallelism 1 -TimeoutSeconds 5 -MinimumSuccessPercent 100 -NetprobePath $cmd -NetprobePrefixArguments @('/d', '/c', $wrongCommitProbe) -ExpectedVersion '0.4.2' -ExpectedSourceCommit $sourceCommit | Out-Null
  } catch {
    if ($_.Exception.Message -notmatch 'all TCP probes failed|success rate') {
      throw "Unexpected exact-build mismatch failure: $($_.Exception.Message)"
    }
    $wrongCommitRejected = $true
  }
  if (-not $wrongCommitRejected) { throw 'Wrong-source-commit Netprobe fixture was unexpectedly accepted.' }

  $stableHealthRequirementsRejected = $false
  try {
    & $scriptUnderTest -TcpBootstrap $tcp -Clients 1 -NetprobePath $cmd -NetprobePrefixArguments @('/d', '/c', $passProbe) -ExpectedVersion '0.4.2' -ExpectedSourceCommit $sourceCommit -RequireStableNodeHealth | Out-Null
  } catch {
    if ($_.Exception.Message -notmatch 'requires HealthPath') {
      throw "Unexpected stable-health prerequisite error: $($_.Exception.Message)"
    }
    $stableHealthRequirementsRejected = $true
  }
  if (-not $stableHealthRequirementsRejected) { throw 'Stable-health mode without HealthPath was unexpectedly accepted.' }

  $rejected = $false
  try {
    & $scriptUnderTest -TcpBootstrap $tcp -Clients 4 -Parallelism 2 -TimeoutSeconds 5 -MinimumSuccessPercent 100 -NetprobePath $cmd -NetprobePrefixArguments @('/d', '/c', $failProbe) | Out-Null
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
