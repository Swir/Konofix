$ErrorActionPreference = 'Stop'
$tool = Join-Path $PSScriptRoot 'install-public-node-task.ps1'
$programData = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::CommonApplicationData)
if ([string]::IsNullOrWhiteSpace($programData)) { throw 'Self-test could not determine CommonApplicationData.' }
$tempState = Join-Path $programData ("Konofix-Task-Test-" + [guid]::NewGuid().ToString('N'))
$outsideRoot = Join-Path $programData ("Konofix-Task-Outside-" + [guid]::NewGuid().ToString('N'))

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
Assert-True ($plan.schema -eq 2) 'Plan schema must be 2 after SYSTEM-task storage hardening.'
Assert-True ($plan.task_name -ceq 'Konofix Public Node Test') 'Task name was not preserved.'
Assert-True ($plan.task_user -ceq 'SYSTEM') 'Startup task must run as SYSTEM.'
Assert-True ($plan.public_host -ceq '8.8.8.8') 'Public host was not normalized correctly.'
Assert-True ($plan.port -eq 46666) 'Custom port was not preserved.'
Assert-True ($plan.status_interval -eq 45) 'Custom status interval was not preserved.'
Assert-True ([bool]$plan.security.state_containment_required) 'SYSTEM-task plan must require protected state containment.'
Assert-True ([bool]$plan.security.dedicated_state_root_required) 'SYSTEM-task plan must require a dedicated state root.'
Assert-True ([bool]$plan.security.reparse_points_rejected) 'SYSTEM-task plan must advertise reparse-point rejection.'
Assert-True ($plan.security.directory_sddl -ceq 'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)') 'Protected directory SDDL drifted.'
Assert-True ($plan.security.file_sddl -ceq 'D:P(A;;FA;;;SY)(A;;FA;;;BA)') 'Protected file SDDL drifted.'
Assert-True ([bool]$plan.firewall.enabled) 'Firewall preview flag was not preserved.'
Assert-True ($plan.firewall.tcp_rule -ceq 'Konofix Public Node TCP 46666') 'TCP firewall rule name is not deterministic.'
Assert-True ($plan.firewall.udp_rule -ceq 'Konofix Public Node UDP 46666') 'UDP firewall rule name is not deterministic.'
Assert-True ($plan.installed_node_path.EndsWith('service\konofix-node.exe', [StringComparison]::OrdinalIgnoreCase)) 'Installed Node path must live under the persistent service directory.'
Assert-True ($plan.installed_launcher_path.EndsWith('service\public-node.ps1', [StringComparison]::OrdinalIgnoreCase)) 'Installed launcher path must live under the persistent service directory.'
$statePrefix = [System.IO.Path]::GetFullPath($tempState).TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar
Assert-True (([string]$plan.identity_file).StartsWith($statePrefix, [StringComparison]::OrdinalIgnoreCase)) 'Identity path must stay under protected state.'
Assert-True (([string]$plan.health_file).StartsWith($statePrefix, [StringComparison]::OrdinalIgnoreCase)) 'Health path must stay under protected state.'
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
Assert-Fails 'external identity path rejection' 'requires IdentityFile to stay inside StateDirectory' {
  & $tool -PublicHost '8.8.8.8' -StateDirectory $tempState -IdentityFile (Join-Path $outsideRoot 'identity.key') -AsJson | Out-Null
}
Assert-Fails 'external health path rejection' 'requires HealthFile to stay inside StateDirectory' {
  & $tool -PublicHost '8.8.8.8' -StateDirectory $tempState -HealthFile (Join-Path $outsideRoot 'health.json') -AsJson | Out-Null
}
Assert-Fails 'state root cannot be identity file' 'requires IdentityFile to stay inside StateDirectory' {
  & $tool -PublicHost '8.8.8.8' -StateDirectory $tempState -IdentityFile $tempState -AsJson | Out-Null
}
Assert-Fails 'filesystem root state rejection' 'never a filesystem root' {
  & $tool -PublicHost '8.8.8.8' -StateDirectory ([System.IO.Path]::GetPathRoot($tempState)) -AsJson | Out-Null
}
Assert-Fails 'ProgramData root state rejection' 'dedicated child of ProgramData' {
  & $tool -PublicHost '8.8.8.8' -StateDirectory $programData -AsJson | Out-Null
}
$tempUnsafe = Join-Path ([System.IO.Path]::GetTempPath()) ('Konofix-' + [guid]::NewGuid().ToString('N'))
Assert-Fails 'temporary-tree state rejection' 'filesystem/system/user/temp tree' {
  & $tool -PublicHost '8.8.8.8' -StateDirectory $tempUnsafe -AsJson | Out-Null
}
$userProfile = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::UserProfile)
if (-not [string]::IsNullOrWhiteSpace($userProfile)) {
  Assert-Fails 'user-profile state rejection' 'filesystem/system/user/temp tree' {
    & $tool -PublicHost '8.8.8.8' -StateDirectory (Join-Path $userProfile 'KonofixNode') -AsJson | Out-Null
  }
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

Write-Host 'OK - startup-task planning is deterministic, encoded-command safe, enforces a dedicated protected state root, exposes the SYSTEM/Admin-only ACL plan and remains mutation-free in self-tests.' -ForegroundColor Green
