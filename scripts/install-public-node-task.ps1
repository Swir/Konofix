[CmdletBinding()]
param(
  [string]$PublicHost = '',

  [ValidateRange(1, 65535)]
  [int]$Port = 45555,

  [ValidateRange(10, 3600)]
  [int]$StatusInterval = 30,

  [string]$StateDirectory = '',
  [string]$IdentityFile = '',
  [string]$HealthFile = '',
  [string]$NodePath = '',

  [string]$TaskName = 'Konofix Public Node',

  [switch]$AllowPrivateAddress,
  [switch]$RequireDnsResolution,
  [switch]$ConfigureFirewall,
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$StartNow,
  [switch]$AsJson
)

$ErrorActionPreference = 'Stop'
$firewallGroup = 'Konofix Public Node'
$privateDirectorySddl = 'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
$privateFileSddl = 'D:P(A;;FA;;;SY)(A;;FA;;;BA)'

function Get-FullPath([string]$PathValue, [string]$Label) {
  try {
    return [System.IO.Path]::GetFullPath($PathValue)
  } catch {
    throw "Invalid $Label path '$PathValue': $($_.Exception.Message)"
  }
}

function Quote-PowerShellLiteral([string]$Value) {
  return "'" + $Value.Replace("'", "''") + "'"
}

function Test-IsPathInside([string]$RootPath, [string]$ChildPath) {
  $rootFull = (Get-FullPath $RootPath 'root').TrimEnd([char[]]@('\', '/'))
  $childFull = Get-FullPath $ChildPath 'child'
  if ([System.StringComparer]::OrdinalIgnoreCase.Equals($rootFull, $childFull)) { return $false }
  $prefix = $rootFull + [System.IO.Path]::DirectorySeparatorChar
  return $childFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-SafeDedicatedStateRoot([string]$PathValue) {
  $full = Get-FullPath $PathValue 'state directory'
  $volumeRoot = [System.IO.Path]::GetPathRoot($full)
  if ([string]::IsNullOrWhiteSpace($volumeRoot)) {
    throw "StateDirectory has no filesystem root: $full"
  }
  $trimmedFull = $full.TrimEnd([char[]]@('\', '/'))
  $trimmedVolume = $volumeRoot.TrimEnd([char[]]@('\', '/'))
  if ([System.StringComparer]::OrdinalIgnoreCase.Equals($trimmedFull, $trimmedVolume)) {
    throw 'StateDirectory must be a dedicated subdirectory, never a filesystem root.'
  }

  $forbiddenBases = @(
    [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Windows),
    [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::ProgramFiles),
    [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::ProgramFilesX86),
    [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::UserProfile),
    [System.IO.Path]::GetTempPath()
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { Get-FullPath $_ 'protected base' } | Select-Object -Unique

  foreach ($base in $forbiddenBases) {
    if ([System.StringComparer]::OrdinalIgnoreCase.Equals($full.TrimEnd([char[]]@('\', '/')), $base.TrimEnd([char[]]@('\', '/'))) -or
        (Test-IsPathInside -RootPath $base -ChildPath $full)) {
      throw "StateDirectory must not be a filesystem/system/user/temp tree used for unrelated content: $full"
    }
  }

  $programData = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::CommonApplicationData)
  if (-not [string]::IsNullOrWhiteSpace($programData)) {
    $programDataFull = Get-FullPath $programData 'ProgramData'
    if ([System.StringComparer]::OrdinalIgnoreCase.Equals($full.TrimEnd([char[]]@('\', '/')), $programDataFull.TrimEnd([char[]]@('\', '/')))) {
      throw 'StateDirectory must be a dedicated child of ProgramData, not ProgramData itself.'
    }
  }
}

function Assert-NoReparsePointInExistingPath([string]$PathValue, [string]$Label) {
  $current = Get-FullPath $PathValue $Label
  while (-not [string]::IsNullOrWhiteSpace($current)) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label path traverses a reparse point and cannot be trusted for a SYSTEM startup task: $current"
      }
    }
    $parent = Split-Path $current -Parent
    if ([string]::IsNullOrWhiteSpace($parent) -or [System.StringComparer]::OrdinalIgnoreCase.Equals($parent, $current)) { break }
    $current = $parent
  }
}

function Set-KonofixPrivateDirectoryAcl([string]$PathValue) {
  $acl = Get-Acl -LiteralPath $PathValue
  $acl.SetSecurityDescriptorSddlForm($privateDirectorySddl, [System.Security.AccessControl.AccessControlSections]::Access)
  Set-Acl -LiteralPath $PathValue -AclObject $acl
}

function Set-KonofixPrivateFileAcl([string]$PathValue) {
  if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) { return }
  $acl = Get-Acl -LiteralPath $PathValue
  $acl.SetSecurityDescriptorSddlForm($privateFileSddl, [System.Security.AccessControl.AccessControlSections]::Access)
  Set-Acl -LiteralPath $PathValue -AclObject $acl
}

function Test-IsAdministrator {
  if (-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core') { return $false }
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch {
    return $false
  }
}

function Assert-Administrator {
  if (-not (Test-IsAdministrator)) {
    throw 'Installing or removing the public Node startup task requires an elevated PowerShell session (Run as Administrator).'
  }
}

function Wait-ScheduledTaskStopped([string]$Name, [int]$TimeoutSeconds = 15) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if ($null -eq $task -or [string]$task.State -ine 'Running') { return }
    Start-Sleep -Milliseconds 250
  }
  throw "Existing startup task '$Name' did not stop within ${TimeoutSeconds}s; refusing to replace its SYSTEM runtime files."
}

function Remove-KonofixFirewallRules {
  if (-not (Get-Command Get-NetFirewallRule -ErrorAction SilentlyContinue)) { return }
  Get-NetFirewallRule -Group $firewallGroup -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
}

if (($Install -and $Uninstall) -or ($AsJson -and ($Install -or $Uninstall))) {
  throw 'Use exactly one mutation mode: -Install or -Uninstall. -AsJson is preview-only and cannot be combined with either.'
}
if ($StartNow -and -not $Install) {
  throw '-StartNow requires -Install.'
}
if ([string]::IsNullOrWhiteSpace($TaskName) -or $TaskName.Length -gt 80 -or $TaskName -notmatch '^[A-Za-z0-9 ._-]+$') {
  throw 'TaskName must be 1-80 characters and contain only letters, digits, spaces, dot, underscore, or hyphen.'
}

if ($Uninstall) {
  Assert-Administrator
  if (-not (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) {
    throw 'Windows ScheduledTasks module is unavailable.'
  }

  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -ne $existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed startup task: $TaskName" -ForegroundColor Green
  } else {
    Write-Host "Startup task was not installed: $TaskName" -ForegroundColor Yellow
  }
  Remove-KonofixFirewallRules
  Write-Host 'Persistent Node state and identity were intentionally preserved.' -ForegroundColor Yellow
  return
}

if ([string]::IsNullOrWhiteSpace($PublicHost)) {
  throw 'PublicHost is required unless -Uninstall is used.'
}

$publicNodeTool = Join-Path $PSScriptRoot 'public-node.ps1'
if (-not (Test-Path $publicNodeTool -PathType Leaf)) {
  throw "Required public Node launcher is missing: $publicNodeTool"
}

if ([string]::IsNullOrWhiteSpace($StateDirectory)) {
  $programData = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::CommonApplicationData)
  if ([string]::IsNullOrWhiteSpace($programData)) {
    throw 'Could not determine ProgramData. Specify -StateDirectory explicitly.'
  }
  $StateDirectory = Join-Path $programData 'Konofix Node'
}
$stateFull = Get-FullPath $StateDirectory 'state directory'
Assert-SafeDedicatedStateRoot $stateFull

$preflightArgs = @{
  PublicHost = $PublicHost
  Port = $Port
  StatusInterval = $StatusInterval
  StateDirectory = $stateFull
  AsJson = $true
}
if (-not [string]::IsNullOrWhiteSpace($IdentityFile)) { $preflightArgs.IdentityFile = $IdentityFile }
if (-not [string]::IsNullOrWhiteSpace($HealthFile)) { $preflightArgs.HealthFile = $HealthFile }
if (-not [string]::IsNullOrWhiteSpace($NodePath)) { $preflightArgs.NodePath = $NodePath }
if ($AllowPrivateAddress) { $preflightArgs.AllowPrivateAddress = $true }
if ($RequireDnsResolution) { $preflightArgs.RequireDnsResolution = $true }

$preflightJson = (& $publicNodeTool @preflightArgs | Out-String).Trim()
if ([string]::IsNullOrWhiteSpace($preflightJson)) { throw 'Public Node preflight returned no configuration.' }
try {
  $publicConfig = $preflightJson | ConvertFrom-Json
} catch {
  throw "Public Node preflight did not return valid JSON: $($_.Exception.Message)"
}

$serviceDirectory = Join-Path $stateFull 'service'
$installedLauncher = Join-Path $serviceDirectory 'public-node.ps1'
$installedNode = Join-Path $serviceDirectory 'konofix-node.exe'
$sourceNode = [string]$publicConfig.node_path
$identityFull = Get-FullPath ([string]$publicConfig.identity_file) 'identity file'
$healthFull = Get-FullPath ([string]$publicConfig.health_file) 'health file'

if (-not (Test-IsPathInside -RootPath $stateFull -ChildPath $identityFull)) {
  throw 'The supervised SYSTEM task requires IdentityFile to stay inside StateDirectory so service ACLs can protect the persistent Peer ID.'
}
if (-not (Test-IsPathInside -RootPath $stateFull -ChildPath $healthFull)) {
  throw 'The supervised SYSTEM task requires HealthFile to stay inside StateDirectory so service ACLs can protect writable telemetry state.'
}

$commandParts = @(
  "& $(Quote-PowerShellLiteral $installedLauncher)",
  "-PublicHost $(Quote-PowerShellLiteral ([string]$publicConfig.public_host))",
  "-Port $Port",
  "-StatusInterval $StatusInterval",
  "-StateDirectory $(Quote-PowerShellLiteral $stateFull)",
  "-IdentityFile $(Quote-PowerShellLiteral $identityFull)",
  "-HealthFile $(Quote-PowerShellLiteral $healthFull)",
  "-NodePath $(Quote-PowerShellLiteral $installedNode)"
)
if ($AllowPrivateAddress) { $commandParts += '-AllowPrivateAddress' }
if ($RequireDnsResolution) { $commandParts += '-RequireDnsResolution' }
$commandParts += '-Start'
$taskCommand = $commandParts -join ' '
$encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($taskCommand))

$windowsPowerShell = if (-not [string]::IsNullOrWhiteSpace($env:SystemRoot)) {
  Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
} else {
  'powershell.exe'
}
$taskArguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encodedCommand"

$plan = [ordered]@{
  schema = 2
  task_name = $TaskName
  task_user = 'SYSTEM'
  public_host = [string]$publicConfig.public_host
  port = $Port
  status_interval = $StatusInterval
  state_directory = $stateFull
  identity_file = $identityFull
  health_file = $healthFull
  source_node_path = $sourceNode
  installed_node_path = $installedNode
  installed_launcher_path = $installedLauncher
  task_execute = $windowsPowerShell
  task_arguments = $taskArguments
  decoded_command = $taskCommand
  restart_interval_seconds = 60
  restart_count = 999
  security = [ordered]@{
    state_containment_required = $true
    dedicated_state_root_required = $true
    reparse_points_rejected = $true
    dacl_mode = 'SYSTEM+Administrators full-control only; inheritance disabled at protected state root'
    directory_sddl = $privateDirectorySddl
    file_sddl = $privateFileSddl
  }
  firewall = [ordered]@{
    enabled = [bool]$ConfigureFirewall
    group = $firewallGroup
    tcp_rule = "$firewallGroup TCP $Port"
    udp_rule = "$firewallGroup UDP $Port"
  }
}

if ($AsJson) {
  $plan | ConvertTo-Json -Depth 6
  return
}

Write-Host '=== Konofix Public Node Startup Task ===' -ForegroundColor Cyan
Write-Host "Task:             $TaskName"
Write-Host 'Run as:           SYSTEM'
Write-Host "Public host:      $($plan.public_host)"
Write-Host "TCP/QUIC port:    $Port"
Write-Host "Persistent state: $stateFull"
Write-Host "Identity file:    $identityFull"
Write-Host "Health file:      $healthFull"
Write-Host "Runtime Node:     $installedNode"
Write-Host 'Auto restart:     up to 999 attempts, 60s interval'
Write-Host "Firewall rules:   $([bool]$ConfigureFirewall)"
Write-Host 'State ACL:         SYSTEM + Administrators full control only (protected DACL)'

if (-not $Install) {
  Write-Host 'Preview passed. Re-run with -Install from an elevated PowerShell session to install/update the startup task.' -ForegroundColor Green
  Write-Host 'The task preserves the Node identity across restarts; -Uninstall never deletes identity/state.' -ForegroundColor Yellow
  return
}

Assert-Administrator
if (-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core') {
  throw 'The startup-task installer is supported on Windows only.'
}
if (-not (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) -or
    -not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue) -or
    -not (Get-Command Stop-ScheduledTask -ErrorAction SilentlyContinue) -or
    -not (Get-Command Start-ScheduledTask -ErrorAction SilentlyContinue)) {
  throw 'Required Windows ScheduledTasks cmdlets are unavailable.'
}
if ($ConfigureFirewall -and (-not (Get-Command Get-NetFirewallRule -ErrorAction SilentlyContinue) -or
                             -not (Get-Command Remove-NetFirewallRule -ErrorAction SilentlyContinue) -or
                             -not (Get-Command New-NetFirewallRule -ErrorAction SilentlyContinue))) {
  throw 'Required Windows firewall cmdlets are unavailable. No startup-task mutation was performed.'
}
if (-not (Test-Path $sourceNode -PathType Leaf)) {
  throw "Konofix Node executable is missing: $sourceNode"
}

Assert-NoReparsePointInExistingPath -PathValue $stateFull -Label 'State directory'
New-Item -ItemType Directory -Force -Path $stateFull | Out-Null
Assert-NoReparsePointInExistingPath -PathValue $stateFull -Label 'State directory'
Set-KonofixPrivateDirectoryAcl $stateFull

New-Item -ItemType Directory -Force -Path $serviceDirectory | Out-Null
Assert-NoReparsePointInExistingPath -PathValue $serviceDirectory -Label 'Service directory'
Set-KonofixPrivateDirectoryAcl $serviceDirectory

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$restartExistingTask = $false
if ($null -ne $existingTask) {
  try {
    $restartExistingTask = ([string]$existingTask.State -ieq 'Running')
  } catch {
    $restartExistingTask = $false
  }
  if ($restartExistingTask) {
    Stop-ScheduledTask -TaskName $TaskName
    Wait-ScheduledTaskStopped -Name $TaskName
  }
}

Copy-Item -LiteralPath $sourceNode -Destination $installedNode -Force
Copy-Item -LiteralPath $publicNodeTool -Destination $installedLauncher -Force
Set-KonofixPrivateFileAcl $installedNode
Set-KonofixPrivateFileAcl $installedLauncher
Set-KonofixPrivateFileAcl $identityFull
Set-KonofixPrivateFileAcl $healthFull

$action = New-ScheduledTaskAction -Execute $windowsPowerShell -Argument $taskArguments
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description 'Konofix Public Node supervised startup task. Persistent identity/state are preserved outside the task definition.' `
  -Force | Out-Null

if ($ConfigureFirewall) {
  Remove-KonofixFirewallRules
  New-NetFirewallRule -DisplayName $plan.firewall.tcp_rule -Group $firewallGroup -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Program $installedNode -Profile Any | Out-Null
  New-NetFirewallRule -DisplayName $plan.firewall.udp_rule -Group $firewallGroup -Direction Inbound -Action Allow -Protocol UDP -LocalPort $Port -Program $installedNode -Profile Any | Out-Null
}

Write-Host "Installed/updated startup task: $TaskName" -ForegroundColor Green
Write-Host "Runtime files staged in: $serviceDirectory" -ForegroundColor Green
Write-Host 'Protected state/runtime DACL: SYSTEM + Administrators only.' -ForegroundColor Green
if ($ConfigureFirewall) {
  Write-Host "Installed TCP + UDP firewall rules for port $Port." -ForegroundColor Green
} else {
  Write-Host "Firewall was not changed. Ensure TCP and UDP port $Port are reachable from the Internet." -ForegroundColor Yellow
}
Write-Host 'Identity/state are intentionally not deleted by task updates or uninstall.' -ForegroundColor Yellow

if ($StartNow -or $restartExistingTask) {
  Start-ScheduledTask -TaskName $TaskName
  if ($StartNow) {
    Write-Host 'Startup task started.' -ForegroundColor Green
  } else {
    Write-Host 'Previously running startup task restarted after the secured update.' -ForegroundColor Green
  }
}
