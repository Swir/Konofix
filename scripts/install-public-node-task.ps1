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

$root = Split-Path $PSScriptRoot -Parent
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

$commandParts = @(
  "& $(Quote-PowerShellLiteral $installedLauncher)",
  "-PublicHost $(Quote-PowerShellLiteral ([string]$publicConfig.public_host))",
  "-Port $Port",
  "-StatusInterval $StatusInterval",
  "-StateDirectory $(Quote-PowerShellLiteral $stateFull)",
  "-IdentityFile $(Quote-PowerShellLiteral ([string]$publicConfig.identity_file))",
  "-HealthFile $(Quote-PowerShellLiteral ([string]$publicConfig.health_file))",
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
  schema = 1
  task_name = $TaskName
  task_user = 'SYSTEM'
  public_host = [string]$publicConfig.public_host
  port = $Port
  status_interval = $StatusInterval
  state_directory = $stateFull
  identity_file = [string]$publicConfig.identity_file
  health_file = [string]$publicConfig.health_file
  source_node_path = $sourceNode
  installed_node_path = $installedNode
  installed_launcher_path = $installedLauncher
  task_execute = $windowsPowerShell
  task_arguments = $taskArguments
  decoded_command = $taskCommand
  restart_interval_seconds = 60
  restart_count = 999
  firewall = [ordered]@{
    enabled = [bool]$ConfigureFirewall
    group = $firewallGroup
    tcp_rule = "$firewallGroup TCP $Port"
    udp_rule = "$firewallGroup UDP $Port"
  }
}

if ($AsJson) {
  $plan | ConvertTo-Json -Depth 5
  return
}

Write-Host '=== Konofix Public Node Startup Task ===' -ForegroundColor Cyan
Write-Host "Task:             $TaskName"
Write-Host "Run as:           SYSTEM"
Write-Host "Public host:      $($plan.public_host)"
Write-Host "TCP/QUIC port:    $Port"
Write-Host "Persistent state: $stateFull"
Write-Host "Identity file:    $($plan.identity_file)"
Write-Host "Health file:      $($plan.health_file)"
Write-Host "Runtime Node:     $installedNode"
Write-Host "Auto restart:     up to 999 attempts, 60s interval"
Write-Host "Firewall rules:   $([bool]$ConfigureFirewall)"

if (-not $Install) {
  Write-Host 'Preview passed. Re-run with -Install from an elevated PowerShell session to install/update the startup task.' -ForegroundColor Green
  Write-Host 'The task preserves the Node identity across restarts; -Uninstall never deletes identity/state.' -ForegroundColor Yellow
  return
}

Assert-Administrator
if (-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core') {
  throw 'The startup-task installer is supported on Windows only.'
}
if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
  throw 'Windows ScheduledTasks module is unavailable.'
}
if (-not (Test-Path $sourceNode -PathType Leaf)) {
  throw "Konofix Node executable is missing: $sourceNode"
}

New-Item -ItemType Directory -Force -Path $serviceDirectory | Out-Null
Copy-Item -LiteralPath $sourceNode -Destination $installedNode -Force
Copy-Item -LiteralPath $publicNodeTool -Destination $installedLauncher -Force

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
  if (-not (Get-Command New-NetFirewallRule -ErrorAction SilentlyContinue)) {
    throw 'Windows firewall cmdlets are unavailable; the startup task was installed but firewall rules were not created.'
  }
  Remove-KonofixFirewallRules
  New-NetFirewallRule -DisplayName $plan.firewall.tcp_rule -Group $firewallGroup -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Program $installedNode -Profile Any | Out-Null
  New-NetFirewallRule -DisplayName $plan.firewall.udp_rule -Group $firewallGroup -Direction Inbound -Action Allow -Protocol UDP -LocalPort $Port -Program $installedNode -Profile Any | Out-Null
}

Write-Host "Installed/updated startup task: $TaskName" -ForegroundColor Green
Write-Host "Runtime files staged in: $serviceDirectory" -ForegroundColor Green
if ($ConfigureFirewall) {
  Write-Host "Installed TCP + UDP firewall rules for port $Port." -ForegroundColor Green
} else {
  Write-Host "Firewall was not changed. Ensure TCP and UDP port $Port are reachable from the Internet." -ForegroundColor Yellow
}
Write-Host 'Identity/state are intentionally not deleted by task updates or uninstall.' -ForegroundColor Yellow

if ($StartNow) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host 'Startup task started.' -ForegroundColor Green
}
