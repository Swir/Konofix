$ErrorActionPreference = 'Stop'
$tool = Join-Path $PSScriptRoot 'install-public-node-task.ps1'
$tempState = Join-Path ([System.IO.Path]::GetTempPath()) ("konofix-public-node-task-test-" + [guid]::NewGuid().ToString('N'))

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Assert-Fails([string]$Label, [string]$ExpectedText, [scriptblock]$Action) {
  $failed = $false
  try {
    & $Action
  } catch {
    $failed = $true
    if (-not $_.Exception.Message.Contains($ExpectedText)) {
      throw "$Label failed with an unexpected error: $($_.Exception.Message)"
    }
  }
  if (-not $failed) { throw "$Label was expected to fail." }
}

Write-Host '=== Konofix Public Node startup-task self-tests ===' -ForegroundColor Cyan

$plan = (& $tool -PublicHost '8.8.8.8' -Port 46666 -StatusInterval 45 -StateDirectory $tempState -TaskName 'Konofix Public Node Test' -ConfigureFirewall -AsJson) | ConvertFrom-Json
Assert-True ($plan.schema -eq 1) 'Plan schema must be 1.'
Assert-True ($plan.task_name -ceq 'Konofix Public Node Test') 'Task name was not preserved.'
Assert-True ($plan.task_user -ceq 'SYSTEM') 'Startup task must run as SYSTEM.'
Assert-True ($plan.public_host -ceq '8.8.8.8') 'Public host was not normalized correctly.'
Assert-True ($plan.port -eq 46666) 'Custom port was not preserved.'
Assert-True ($plan.status_interval -eq 45) 'Custom status interval was not preserved.'
Assert-True ([bool]$plan.firewall.enabled) 'Firewall preview flag was not preserved.'
Assert-True ($plan.firewall.tcp_rule -ceq 'Konofix Public Node TCP 46666') 'TCP firewall rule name is not deterministic.'
Assert-True ($plan.firewall.udp_rule -ceq 'Konofix Public Node UDP 46666') 'UDP firewall rule name is not deterministic.'
Assert-True ($plan.installed_node_path.EndsWith('service\konofix-node.exe', [StringComparison]::OrdinalIgnoreCase)) 'Installed Node path must live under the persistent service directory.'
Assert-True ($plan.installed_launcher_path.EndsWith('service\public-node.ps1', [StringComparison]::OrdinalIgnoreCase)) 'Installed launcher path must live under the persistent service directory.'
Assert-True ($plan.decoded_command.Contains('-Start')) 'Scheduled command must start the public Node launcher.'
Assert-True ($plan.decoded_command.Contains('-NodePath')) 'Scheduled command must pin the staged Node executable.'
Assert-True ($plan.decoded_command.Contains('46666')) 'Scheduled command must preserve the configured port.'

$encodedMarker = '-EncodedCommand '
$markerIndex = ([string]$plan.task_arguments).IndexOf($encodedMarker, [StringComparison]::Ordinal)
Assert-True ($markerIndex -ge 0) 'Task action must use an encoded PowerShell command.'
$encoded = ([string]$plan.task_arguments).Substring($markerIndex + $encodedMarker.Length).Trim()
$decoded = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded))
Assert-True ([string]::Equals($decoded, [string]$plan.decoded_command, [StringComparison]::Ordinal)) 'Encoded task command does not round-trip exactly.'

$lab = (& $tool -PublicHost '192.168.50.5' -StateDirectory $tempState -AllowPrivateAddress -AsJson) | ConvertFrom-Json
Assert-True ($lab.public_host -ceq '192.168.50.5') 'Controlled lab override must flow through the existing public-node preflight.'
Assert-True ($lab.decoded_command.Contains('-AllowPrivateAddress')) 'Lab override must be preserved in the scheduled command.'

Assert-Fails 'private address rejection' 'private, local, CGNAT, documentation, multicast, or otherwise non-public' {
  & $tool -PublicHost '192.168.50.5' -StateDirectory $tempState -AsJson | Out-Null
}
Assert-Fails 'invalid task name rejection' 'TaskName must be 1-80 characters' {
  & $tool -PublicHost '8.8.8.8' -StateDirectory $tempState -TaskName '..\bad' -AsJson | Out-Null
}
Assert-Fails 'conflicting mutation mode rejection' 'Use exactly one mutation mode' {
  & $tool -PublicHost '8.8.8.8' -StateDirectory $tempState -Install -Uninstall | Out-Null
}
Assert-Fails 'preview/mutation mode rejection' 'preview-only' {
  & $tool -PublicHost '8.8.8.8' -StateDirectory $tempState -Install -AsJson | Out-Null
}
Assert-Fails 'start-now mode rejection' '-StartNow requires -Install' {
  & $tool -PublicHost '8.8.8.8' -StateDirectory $tempState -StartNow -AsJson | Out-Null
}

Write-Host 'OK - startup-task planning is deterministic, encoded-command safe, reuses public-host validation and stays mutation-free in self-tests.' -ForegroundColor Green
