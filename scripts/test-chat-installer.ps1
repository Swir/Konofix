$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# This installs/uninstalls into a disposable GitHub runner account. Never run it
# against a developer's existing installation or rewrite their Start menu.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or -not $env:RUNNER_TEMP) {
    throw 'Installer smoke requires a disposable Windows GitHub Actions runner.'
}

$repoRoot = Split-Path $PSScriptRoot -Parent
$releaseRoot = Join-Path $repoRoot 'src-tauri\target\release'
$chat = Join-Path $releaseRoot 'konofix-chat.exe'
if (-not (Test-Path -LiteralPath $chat -PathType Leaf)) { throw 'Production Chat EXE is missing.' }

# Check the actual PE subsystem, not just a source-code attribute.
$binary = [IO.File]::ReadAllBytes($chat)
$peOffset = [BitConverter]::ToInt32($binary, 0x3c)
if ([BitConverter]::ToUInt16($binary, $peOffset + 24 + 68) -ne 2) {
    throw 'Production Chat must use the Windows GUI subsystem, without a console window.'
}

# Tauri 2.11.4 patches this fixed-width marker before packaging, then restores
# the original EXE after EACH format. Derive the exact expected bytes for each
# installer in memory; do not ignore any other byte or modify the real binary.
# https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle.rs
$markerOffset = [Text.Encoding]::ASCII.GetString($binary).IndexOf('__TAURI_BUNDLE_TYPE_VAR_UNK', [StringComparison]::Ordinal)
if ($markerOffset -lt 0) { throw 'Production Chat is missing the Tauri bundle marker.' }
function Get-ExpectedBundleHash([ValidateSet('MSI', 'NSS')][string]$Format) {
    $expected = [byte[]]$binary.Clone()
    $marker = [Text.Encoding]::ASCII.GetBytes("__TAURI_BUNDLE_TYPE_VAR_$Format")
    [Array]::Copy($marker, 0, $expected, $markerOffset, $marker.Length)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($expected))
}
$expectedMsiHash = Get-ExpectedBundleHash 'MSI'
$expectedNsisHash = Get-ExpectedBundleHash 'NSS'

$installers = @(Get-ChildItem -LiteralPath (Join-Path $releaseRoot 'bundle\nsis') -Filter '*-setup.exe' -File)
$msis = @(Get-ChildItem -LiteralPath (Join-Path $releaseRoot 'bundle\msi') -Filter '*.msi' -File)
if ($installers.Count -ne 1 -or $msis.Count -ne 1) { throw 'Expected exactly one NSIS and one MSI installer.' }
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Programs')) 'Konofix Chat.lnk'
if (Test-Path -LiteralPath $shortcutPath) { throw 'Refusing to replace an existing Chat shortcut.' }
if (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Konofix Chat')) {
    throw 'Refusing to replace an existing Chat installation.'
}

$tempRoot = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path
$smokeRoot = Join-Path $tempRoot ('konofix-chat-smoke-' + [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $smokeRoot 'installed chat'
$msiRoot = Join-Path $smokeRoot 'msi'
New-Item -ItemType Directory -Path $smokeRoot | Out-Null
$process = $null
$oldBrowserArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$oldUserData = $env:WEBVIEW2_USER_DATA_FOLDER

function Wait-SmokeProcess($Process, [int]$Seconds, [string]$Label) {
    if (-not $Process.WaitForExit($Seconds * 1000)) {
        $Process.Kill($true)
        throw "$Label timed out."
    }
    if ($Process.ExitCode -ne 0) { throw "$Label failed: exit code $($Process.ExitCode)." }
}

try {
    # Inspect the real MSI payload too; a renamed helper binary cannot pass.
    & 7z x $msis[0].FullName "-o$msiRoot" -y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not extract the MSI payload.' }
    # A CAB member uses MSI's File identifier (WiX uses "Path"), not the
    # installed filename. Resolve that identifier through the actual File table.
    $msiDatabase = (New-Object -ComObject WindowsInstaller.Installer).OpenDatabase($msis[0].FullName, 0)
    $fileView = $msiDatabase.OpenView('SELECT `File`, `FileName` FROM `File`')
    $fileView.Execute()
    $chatFileIds = @()
    while ($record = $fileView.Fetch()) {
        if (($record.StringData(2) -split '\|')[-1] -ceq 'konofix-chat.exe') {
            $chatFileIds += $record.StringData(1)
        }
    }
    $fileView.Close()
    if ($chatFileIds.Count -ne 1) { throw 'MSI File table must install exactly one konofix-chat.exe.' }
    $msiChat = @(Get-ChildItem -LiteralPath $msiRoot -Recurse -File | Where-Object { $_.Name -ceq $chatFileIds[0] })
    if ($msiChat.Count -ne 1 -or (Get-FileHash -LiteralPath $msiChat[0].FullName -Algorithm SHA256).Hash -ne $expectedMsiHash) {
        Get-ChildItem -LiteralPath $msiRoot -Recurse -File | Select-Object FullName, Length | Format-Table -AutoSize
        throw 'MSI does not contain the exact production Chat executable.'
    }
    Write-Host 'MSI Chat payload matches the production executable.'

    $installer = Start-Process -FilePath $installers[0].FullName -ArgumentList "/S /D=$installRoot" -WindowStyle Hidden -PassThru
    Wait-SmokeProcess $installer 120 'NSIS installation'
    $installedChat = Join-Path $installRoot 'konofix-chat.exe'
    if (-not (Test-Path -LiteralPath $installedChat -PathType Leaf)) { throw 'NSIS installed no Chat executable.' }
    if ((Get-FileHash -LiteralPath $installedChat -Algorithm SHA256).Hash -ne $expectedNsisHash) {
        throw 'Installed Chat differs from the production executable.'
    }
    if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { throw 'Start menu shortcut is missing.' }
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
    if ($shortcut.TargetPath -ne $installedChat -or $shortcut.Arguments) {
        throw "Start menu points to the wrong application: $($shortcut.TargetPath)"
    }
    Write-Host 'NSIS payload and Start menu target are the exact production Chat executable.'

    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port"
    $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $smokeRoot 'webview'
    $process = Start-Process -FilePath $shortcut.TargetPath -WorkingDirectory $installRoot -WindowStyle Hidden -PassThru
    & node (Join-Path $PSScriptRoot 'check-chat-page.mjs') $port
    if ($LASTEXITCODE -ne 0) { throw 'Installed Chat frontend smoke failed.' }
    $process.Refresh()
    if ($process.HasExited) { throw "Installed Chat exited unexpectedly: $($process.ExitCode)" }
    Write-Host 'Installed Chat startup smoke PASS (MSI payload, NSIS installation, Start menu, rendered frontend).'
} finally {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $oldBrowserArguments
    $env:WEBVIEW2_USER_DATA_FOLDER = $oldUserData
    if ($null -ne $process -and -not $process.HasExited) {
        $process.Kill($true)
        $process.WaitForExit()
    }
    $uninstaller = Join-Path $installRoot 'uninstall.exe'
    if (Test-Path -LiteralPath $uninstaller) {
        $uninstall = Start-Process -FilePath $uninstaller -ArgumentList "/S _?=$installRoot" -WindowStyle Hidden -PassThru
        Wait-SmokeProcess $uninstall 60 'NSIS cleanup'
    }
    $resolved = [IO.Path]::GetFullPath($smokeRoot)
    if (-not $resolved.StartsWith($tempRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing cleanup outside RUNNER_TEMP.'
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

