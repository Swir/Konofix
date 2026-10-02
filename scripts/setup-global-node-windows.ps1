[CmdletBinding()]
param(
  [string]$PublicHost = '',
  [ValidateRange(1, 65535)]
  [int]$Port = 45555
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$installer = Join-Path $PSScriptRoot 'install-public-node-task.ps1'
$node = Join-Path $root 'konofix-node.exe'
$state = Join-Path ([System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::CommonApplicationData)) 'KonofixNode'

if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
  throw "Missing installer helper: $installer"
}
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
  throw "Missing Konofix Node binary: $node"
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script from an elevated PowerShell window (Run as administrator).'
}

if ([string]::IsNullOrWhiteSpace($PublicHost)) {
  $PublicHost = Read-Host 'Public IPv4/IPv6 or DNS name for this Windows node'
}
$PublicHost = $PublicHost.Trim()
if ([string]::IsNullOrWhiteSpace($PublicHost)) {
  throw 'PublicHost is required.'
}

$ip = $null
$isIp = [System.Net.IPAddress]::TryParse($PublicHost.Trim('[', ']'), [ref]$ip)
$preflight = @{
  PublicHost = $PublicHost
  Port = $Port
  StateDirectory = $state
  NodePath = $node
  ConfigureFirewall = $true
}
if (-not $isIp) {
  $preflight.RequireDnsResolution = $true
}

Write-Host ''
Write-Host '=== KONOFIX GLOBAL NODE / WINDOWS PREFLIGHT ===' -ForegroundColor Cyan
Write-Host 'This installs a persistent Scheduled Task and Windows Firewall rules for TCP+UDP.' -ForegroundColor Gray
Write-Host 'If this is a home PC behind a router, you still need router port forwarding for TCP and UDP.' -ForegroundColor Yellow
Write-Host 'If the ISP uses CGNAT, this machine may not be reachable as a public bootstrap.' -ForegroundColor Yellow
Write-Host ''

& $installer @preflight
Write-Host ''
$answer = Read-Host "Type INSTALL to apply this exact plan"
if ($answer -cne 'INSTALL') {
  Write-Host 'Cancelled. No system changes were made.' -ForegroundColor Yellow
  exit 2
}

& $installer @preflight -Install -StartNow

$health = Join-Path $state 'node-health.json'
for ($i = 0; $i -lt 30; $i++) {
  if (Test-Path -LiteralPath $health -PathType Leaf) { break }
  Start-Sleep -Seconds 1
}

Write-Host ''
Write-Host '=== KONOFIX GLOBAL NODE INSTALLED ===' -ForegroundColor Green
Write-Host "State: $state"
Write-Host "Health: $health"
Write-Host 'Keep node-identity.key private and persistent; deleting it changes the Node Peer ID.' -ForegroundColor Yellow
Write-Host 'Next: verify reachability from another Internet network before adding this node to the canonical bootstrap pool.' -ForegroundColor Cyan
