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

if ([string]::IsNullOrWhiteSpace($NetprobePath)) {
  $NetprobePath = Join-Path (Split-Path -Parent $PSScriptRoot) 'konofix-netprobe.exe'
}
$NetprobePath = [IO.Path]::GetFullPath($NetprobePath)
if (-not (Test-Path -LiteralPath $NetprobePath -PathType Leaf)) {
  throw "Konofix Netprobe was not found: $NetprobePath"
}

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
          $success = ([string]$evidence.status -ceq 'pass')
          if (-not $success) {
            $parseError = 'Netprobe returned exit code 0 without status=pass.'
          }
        } catch {
          $parseError = "Netprobe output was not valid JSON: $($_.Exception.Message)"
        }
      }

      $exitCode = if ($externalTimeout) { -1 } else { [int]$job.Process.ExitCode }
      $results.Add([pscustomobject]@{
        index = [int]$job.Spec.Index
        transport = [string]$job.Spec.Transport
        target = [string]$job.Spec.Target
        success = [bool]$success
        exit_code = $exitCode
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

  $tcpResults = @($ordered | Where-Object transport -eq 'tcp')
  $quicResults = @($ordered | Where-Object transport -eq 'quic-v1')
  $rtts = @($ordered | Where-Object { $_.success -and $null -ne $_.rtt_micros } | ForEach-Object { [int64]$_.rtt_micros } | Sort-Object)
  $averageRtt = if ($rtts.Count -gt 0) { [int64](($rtts | Measure-Object -Average).Average) } else { $null }
  $p95Rtt = if ($rtts.Count -gt 0) {
    $p95Index = [Math]::Min($rtts.Count - 1, [Math]::Max(0, [Math]::Ceiling($rtts.Count * 0.95) - 1))
    [int64]$rtts[$p95Index]
  } else { $null }

  $summary = [ordered]@{
    schema = 1
    tool = 'konofix-global-beta-load'
    status = if ($successPercent -ge $MinimumSuccessPercent) { 'pass' } else { 'fail' }
    clients = $Clients
    parallelism = $Parallelism
    timeout_seconds = $TimeoutSeconds
    minimum_success_percent = $MinimumSuccessPercent
    passed = $passed
    failed = $failed
    success_percent = $successPercent
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

  $json = $summary | ConvertTo-Json -Depth 7
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
