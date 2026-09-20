[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$TcpBootstrap,
  [string]$QuicBootstrap = '',
  [ValidateRange(1, 512)]
  [int]$Clients = 32,
  [ValidateRange(1, 64)]
  [int]$Parallelism = 8,
  [ValidateRange(5, 120)]
  [int]$TimeoutSeconds = 20,
  [ValidateRange(1, 100)]
  [double]$MinimumSuccessPercent = 95,
  [string]$NetprobePath = '',
  [string[]]$NetprobePrefixArguments = @(),
  [string]$ExpectedVersion = '',
  [string]$ExpectedSourceCommit = '',
  [string]$HealthPath = '',
  [ValidateRange(10, 86400)]
  [int]$HealthMaxAgeSeconds = 120,
  [ValidateRange(1, 180)]
  [int]$PostHealthWaitSeconds = 90,
  [switch]$RequireStableNodeHealth,
  [string]$OutputPath = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($TcpBootstrap)) {
  throw 'TcpBootstrap is required.'
}
if (-not $TcpBootstrap.Contains('/tcp/') -or -not $TcpBootstrap.Contains('/p2p/')) {
  throw 'TcpBootstrap must be a direct TCP multiaddr ending in /p2p/<PeerId>.'
}
if (-not [string]::IsNullOrWhiteSpace($QuicBootstrap)) {
  if (-not $QuicBootstrap.Contains('/udp/') -or -not $QuicBootstrap.Contains('/quic-v1/') -or -not $QuicBootstrap.Contains('/p2p/')) {
    throw 'QuicBootstrap must be a direct QUIC-v1 multiaddr ending in /p2p/<PeerId>.'
  }
}
if (-not [string]::IsNullOrWhiteSpace($ExpectedSourceCommit) -and $ExpectedSourceCommit -cnotmatch '^[0-9a-f]{40}$') {
  throw 'ExpectedSourceCommit must be a canonical lowercase 40-character Git commit SHA.'
}
if ($RequireStableNodeHealth) {
  if ([string]::IsNullOrWhiteSpace($HealthPath)) {
    throw 'RequireStableNodeHealth requires HealthPath.'
  }
  if ([string]::IsNullOrWhiteSpace($ExpectedVersion)) {
    throw 'RequireStableNodeHealth requires ExpectedVersion so Node health is exact-version-bound.'
  }
  if ([string]::IsNullOrWhiteSpace($ExpectedSourceCommit)) {
    throw 'RequireStableNodeHealth requires ExpectedSourceCommit so Node health is exact-build-bound.'
  }
}

if ([string]::IsNullOrWhiteSpace($NetprobePath)) {
  $NetprobePath = Join-Path (Split-Path -Parent $PSScriptRoot) 'konofix-netprobe.exe'
}
$NetprobePath = [IO.Path]::GetFullPath($NetprobePath)
if (-not (Test-Path -LiteralPath $NetprobePath -PathType Leaf)) {
  throw "Konofix Netprobe was not found: $NetprobePath"
}
$netprobeItem = Get-Item -LiteralPath $NetprobePath -ErrorAction Stop
$netprobeSha256 = (Get-FileHash -LiteralPath $NetprobePath -Algorithm SHA256).Hash.ToLowerInvariant()

$healthValidator = Join-Path $PSScriptRoot 'check-node-health.ps1'
if (-not [string]::IsNullOrWhiteSpace($HealthPath) -and -not (Test-Path -LiteralPath $healthValidator -PathType Leaf)) {
  throw "Node health validator was not found: $healthValidator"
}

function Get-ValidatedNodeHealth {
  if ([string]::IsNullOrWhiteSpace($HealthPath)) { return $null }

  $arguments = @{
    Path = $HealthPath
    MaxAgeSeconds = $HealthMaxAgeSeconds
    AsJson = $true
  }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedVersion)) {
    $arguments.ExpectedVersion = $ExpectedVersion
  }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedSourceCommit)) {
    $arguments.ExpectedSourceCommit = $ExpectedSourceCommit
  }

  $json = & $healthValidator @arguments
  return (($json -join [Environment]::NewLine) | ConvertFrom-Json -ErrorAction Stop)
}

function Test-ExactProbeEvidence {
  param(
    [Parameter(Mandatory = $true)]$Evidence,
    [Parameter(Mandatory = $true)]$Spec
  )

  if ([string]$Evidence.status -cne 'pass') {
    throw 'Netprobe returned exit code 0 without status=pass.'
  }
  if ($null -eq $Evidence.tool -or [string]$Evidence.tool -cne 'konofix-netprobe') {
    throw 'Netprobe evidence is missing tool=konofix-netprobe.'
  }
  if ($null -eq $Evidence.version -or [string]::IsNullOrWhiteSpace([string]$Evidence.version)) {
    throw 'Netprobe evidence is missing a non-empty version.'
  }
  if ($null -eq $Evidence.source_commit -or [string]$Evidence.source_commit -cnotmatch '^[0-9a-f]{40}$') {
    throw 'Netprobe evidence source_commit is not a canonical lowercase 40-character Git SHA.'
  }
  if ($null -eq $Evidence.transport -or [string]$Evidence.transport -cne [string]$Spec.Transport) {
    throw "Netprobe transport mismatch (expected=$($Spec.Transport) actual=$($Evidence.transport))."
  }
  if ($null -eq $Evidence.target -or [string]$Evidence.target -cne [string]$Spec.Target) {
    throw 'Netprobe evidence target does not match the requested target.'
  }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedVersion) -and [string]$Evidence.version -cne $ExpectedVersion) {
    throw "Netprobe version mismatch (expected=$ExpectedVersion actual=$($Evidence.version))."
  }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedSourceCommit) -and [string]$Evidence.source_commit -cne $ExpectedSourceCommit) {
    throw "Netprobe source commit mismatch (expected=$ExpectedSourceCommit actual=$($Evidence.source_commit))."
  }
}

$preHealth = Get-ValidatedNodeHealth
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("konofix-global-beta-load-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

$pending = [System.Collections.Generic.Queue[object]]::new()
for ($index = 1; $index -le $Clients; $index++) {
  $useQuic = (-not [string]::IsNullOrWhiteSpace($QuicBootstrap)) -and (($index % 2) -eq 0)
  $pending.Enqueue([pscustomobject]@{
    Index = $index
    Transport = if ($useQuic) { 'quic-v1' } else { 'tcp' }
    Target = if ($useQuic) { $QuicBootstrap } else { $TcpBootstrap }
  })
}

$active = [System.Collections.Generic.List[object]]::new()
$results = [System.Collections.Generic.List[object]]::new()

try {
  while ($pending.Count -gt 0 -or $active.Count -gt 0) {
    while ($pending.Count -gt 0 -and $active.Count -lt $Parallelism) {
      $spec = $pending.Dequeue()
      $stdout = Join-Path $tempRoot ("probe-{0:D4}.out.json" -f $spec.Index)
      $stderr = Join-Path $tempRoot ("probe-{0:D4}.err.txt" -f $spec.Index)
      $probeArguments = @($NetprobePrefixArguments) + @('--timeout', [string]$TimeoutSeconds, [string]$spec.Target)
      $process = Start-Process -FilePath $NetprobePath -ArgumentList $probeArguments -NoNewWindow -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr

      $active.Add([pscustomobject]@{
        Spec = $spec
        Process = $process
        Stdout = $stdout
        Stderr = $stderr
        Deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds + 10)
      })
    }

    $madeProgress = $false
    for ($activeIndex = $active.Count - 1; $activeIndex -ge 0; $activeIndex--) {
      $job = $active[$activeIndex]
      $exited = $job.Process.WaitForExit(0)
      $externalTimeout = (-not $exited) -and ([DateTimeOffset]::UtcNow -ge $job.Deadline)
      if (-not $exited -and -not $externalTimeout) {
        continue
      }

      if ($externalTimeout) {
        try {
          $job.Process.Kill($true)
          $job.Process.WaitForExit()
        } catch {}
      } else {
        $job.Process.WaitForExit()
      }

      $stdoutText = if (Test-Path -LiteralPath $job.Stdout) { Get-Content -LiteralPath $job.Stdout -Raw } else { '' }
      $stderrText = if (Test-Path -LiteralPath $job.Stderr) { Get-Content -LiteralPath $job.Stderr -Raw } else { '' }

      $success = $false
      $evidence = $null
      $parseError = if ($externalTimeout) { "Netprobe exceeded external deadline of $($TimeoutSeconds + 10) seconds." } else { $null }
      if (-not $externalTimeout -and $job.Process.ExitCode -eq 0) {
        try {
          $evidence = $stdoutText | ConvertFrom-Json -ErrorAction Stop
          Test-ExactProbeEvidence -Evidence $evidence -Spec $job.Spec
          $success = $true
        } catch {
          $parseError = "Netprobe evidence validation failed: $($_.Exception.Message)"
        }
      }

      $exitCode = if ($externalTimeout) { -1 } else { [int]$job.Process.ExitCode }
      $results.Add([pscustomobject]@{
        index = [int]$job.Spec.Index
        transport = [string]$job.Spec.Transport
        target = [string]$job.Spec.Target
        success = [bool]$success
        exit_code = $exitCode
        version = if ($null -ne $evidence -and $null -ne $evidence.version) { [string]$evidence.version } else { $null }
        source_commit = if ($null -ne $evidence -and $null -ne $evidence.source_commit) { [string]$evidence.source_commit } else { $null }
        observed_peer_id = if ($null -ne $evidence -and $null -ne $evidence.observed_peer_id) { [string]$evidence.observed_peer_id } else { $null }
        rtt_micros = if ($null -ne $evidence -and $null -ne $evidence.rtt_micros) { [int64]$evidence.rtt_micros } else { $null }
        elapsed_millis = if ($null -ne $evidence -and $null -ne $evidence.elapsed_millis) { [int64]$evidence.elapsed_millis } else { $null }
        error = if ($success) { $null } elseif (-not [string]::IsNullOrWhiteSpace($parseError)) { $parseError } elseif (-not [string]::IsNullOrWhiteSpace($stderrText)) { $stderrText.Trim() } else { 'Netprobe failed without stderr output.' }
      })

      $job.Process.Dispose()
      Remove-Item -LiteralPath $job.Stdout,$job.Stderr -Force -ErrorAction SilentlyContinue
      $active.RemoveAt($activeIndex)
      $madeProgress = $true
    }

    if (-not $madeProgress) {
      Start-Sleep -Milliseconds 50
    }
  }

  $ordered = @($results | Sort-Object index)
  $passed = @($ordered | Where-Object success).Count
  $failed = $Clients - $passed
  $successPercent = [Math]::Round(($passed * 100.0) / $Clients, 2)

  $successfulVersions = @($ordered | Where-Object success | Select-Object -ExpandProperty version -Unique)
  $successfulCommits = @($ordered | Where-Object success | Select-Object -ExpandProperty source_commit -Unique)
  if ($successfulVersions.Count -gt 1) {
    throw "Global beta load check failed: successful probes reported mixed versions ($($successfulVersions -join ', '))."
  }
  if ($successfulCommits.Count -gt 1) {
    throw "Global beta load check failed: successful probes reported mixed source commits ($($successfulCommits -join ', '))."
  }

  $postHealth = $null
  if ($null -ne $preHealth) {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($PostHealthWaitSeconds)
    $lastHealthError = $null
    do {
      try {
        $candidate = Get-ValidatedNodeHealth
        if ([int64]$candidate.timestamp_unix -gt [int64]$preHealth.timestamp_unix) {
          $postHealth = $candidate
          break
        }
      } catch {
        $lastHealthError = $_.Exception.Message
      }
      Start-Sleep -Seconds 1
    } while ([DateTimeOffset]::UtcNow -lt $deadline)

    if ($null -eq $postHealth) {
      $suffix = if ([string]::IsNullOrWhiteSpace($lastHealthError)) { '' } else { " Last validator error: $lastHealthError" }
      throw "Global beta load check failed: Node health did not advance after the load within $PostHealthWaitSeconds seconds.$suffix"
    }
    if ([string]$postHealth.peer_id -cne [string]$preHealth.peer_id) {
      throw 'Global beta load check failed: Node Peer ID changed during the load.'
    }
    if ([string]$postHealth.version -cne [string]$preHealth.version) {
      throw 'Global beta load check failed: Node version changed during the load.'
    }
    if ([string]$postHealth.source_commit -cne [string]$preHealth.source_commit) {
      throw 'Global beta load check failed: Node source commit changed during the load.'
    }
    if ([int64]$postHealth.uptime_seconds -lt [int64]$preHealth.uptime_seconds) {
      throw 'Global beta load check failed: Node uptime moved backwards, indicating a restart.'
    }
    $preBootEpoch = [int64]$preHealth.timestamp_unix - [int64]$preHealth.uptime_seconds
    $postBootEpoch = [int64]$postHealth.timestamp_unix - [int64]$postHealth.uptime_seconds
    if ([Math]::Abs($postBootEpoch - $preBootEpoch) -gt 2) {
      throw 'Global beta load check failed: Node boot epoch changed during the load, indicating a restart.'
    }
  }

  $tcpResults = @($ordered | Where-Object transport -eq 'tcp')
  $quicResults = @($ordered | Where-Object transport -eq 'quic-v1')
  $rtts = @($ordered | Where-Object { $_.success -and $null -ne $_.rtt_micros } | ForEach-Object { [int64]$_.rtt_micros } | Sort-Object)
  $averageRtt = if ($rtts.Count -gt 0) { [int64](($rtts | Measure-Object -Average).Average) } else { $null }
  $p95Rtt = if ($rtts.Count -gt 0) {
    $p95Index = [Math]::Min($rtts.Count - 1, [Math]::Max(0, [Math]::Ceiling($rtts.Count * 0.95) - 1))
    [int64]$rtts[$p95Index]
  } else { $null }

  $summary = [ordered]@{
    schema = 2
    tool = 'konofix-global-beta-load'
    status = if ($successPercent -ge $MinimumSuccessPercent) { 'pass' } else { 'fail' }
    clients = $Clients
    parallelism = $Parallelism
    timeout_seconds = $TimeoutSeconds
    minimum_success_percent = $MinimumSuccessPercent
    passed = $passed
    failed = $failed
    success_percent = $successPercent
    exact_build = [ordered]@{
      version = if ($successfulVersions.Count -eq 1) { [string]$successfulVersions[0] } else { $null }
      source_commit = if ($successfulCommits.Count -eq 1) { [string]$successfulCommits[0] } else { $null }
      netprobe_sha256 = $netprobeSha256
      netprobe_bytes = [int64]$netprobeItem.Length
    }
    node_health = if ($null -ne $preHealth -and $null -ne $postHealth) {
      [ordered]@{
        verified = $true
        peer_id = [string]$preHealth.peer_id
        version = [string]$preHealth.version
        source_commit = [string]$preHealth.source_commit
        pre_timestamp_unix = [int64]$preHealth.timestamp_unix
        post_timestamp_unix = [int64]$postHealth.timestamp_unix
        pre_uptime_seconds = [int64]$preHealth.uptime_seconds
        post_uptime_seconds = [int64]$postHealth.uptime_seconds
      }
    } else {
      [ordered]@{ verified = $false }
    }
    tcp = [ordered]@{
      attempted = $tcpResults.Count
      passed = @($tcpResults | Where-Object success).Count
    }
    quic = [ordered]@{
      attempted = $quicResults.Count
      passed = @($quicResults | Where-Object success).Count
    }
    rtt_micros = [ordered]@{
      average = $averageRtt
      p95 = $p95Rtt
      maximum = if ($rtts.Count -gt 0) { [int64]$rtts[-1] } else { $null }
    }
    generated_utc = [DateTimeOffset]::UtcNow.ToString('o')
    results = $ordered
  }

  $json = $summary | ConvertTo-Json -Depth 8
  if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
    $resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
    $parent = Split-Path -Parent $resolvedOutput
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
      New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    [IO.File]::WriteAllText($resolvedOutput, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
  }

  Write-Output $json

  if ($tcpResults.Count -gt 0 -and @($tcpResults | Where-Object success).Count -eq 0) {
    throw 'Global beta load check failed: all TCP probes failed.'
  }
  if ($quicResults.Count -gt 0 -and @($quicResults | Where-Object success).Count -eq 0) {
    throw 'Global beta load check failed: all QUIC-v1 probes failed.'
  }
  if ($successPercent -lt $MinimumSuccessPercent) {
    throw "Global beta load check failed: success rate $successPercent% is below required $MinimumSuccessPercent%."
  }
} finally {
  foreach ($job in @($active)) {
    try {
      if (-not $job.Process.HasExited) {
        $job.Process.Kill($true)
        $job.Process.WaitForExit()
      }
      $job.Process.Dispose()
    } catch {}
  }
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
