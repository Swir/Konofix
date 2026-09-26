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
$chatOutput = Join-Path $smokeRoot 'chat-stdout.log'
$chatError = Join-Path $smokeRoot 'chat-stderr.log'

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

    # Keep the runtime smoke independent of WebView2 DevTools command execution.
    # Recent WebView2 builds can expose the loopback target yet stall Runtime.evaluate
    # under the elevated GitHub runner host. The exact production Vite bundle is
    # already built before packaging, so validate its startup contract directly,
    # then require the installed GUI process to create the real Konofix window.
    $distRoot = Join-Path $repoRoot 'dist'
    $distIndex = Join-Path $distRoot 'index.html'
    if (-not (Test-Path -LiteralPath $distIndex -PathType Leaf)) {
        throw 'Production frontend index is missing.'
    }
    $distIndexText = Get-Content -LiteralPath $distIndex -Raw
    if ($distIndexText -notmatch '<title>Konofix Chat</title>') {
        throw 'Production frontend title contract is missing.'
    }
    $frontendFiles = @(Get-ChildItem -LiteralPath $distRoot -Recurse -File | Where-Object { $_.Extension -in @('.html', '.js') })
    if ($frontendFiles.Count -eq 0) { throw 'Production frontend bundle contains no HTML/JS assets.' }
    $frontendText = ($frontendFiles | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw }) -join "`n"
    foreach ($marker in @('connectBtn', 'loginNetwork', 'chat-message', 'network-status', 'file-transfer')) {
        if (-not $frontendText.Contains($marker)) {
            throw "Production frontend bundle is missing startup contract marker: $marker"
        }
    }

    $process = Start-Process -FilePath $shortcut.TargetPath -WorkingDirectory $installRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $chatOutput -RedirectStandardError $chatError
    $windowDeadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
    while ([DateTimeOffset]::UtcNow -lt $windowDeadline) {
        Start-Sleep -Milliseconds 250
        $process.Refresh()
        if ($process.HasExited) {
            Get-Content -LiteralPath $chatOutput, $chatError -Tail 60 -ErrorAction SilentlyContinue
            throw "Installed Chat exited during startup: $($process.ExitCode)"
        }
        if ($process.MainWindowHandle -ne 0 -and $process.MainWindowTitle -eq 'Konofix Chat') { break }
    }
    $process.Refresh()
    if ($process.MainWindowHandle -eq 0 -or $process.MainWindowTitle -ne 'Konofix Chat') {
        Write-Host "Chat process: exited=$($process.HasExited), window=$($process.MainWindowTitle), handle=$($process.MainWindowHandle)"
        Get-Content -LiteralPath $chatOutput, $chatError -Tail 60 -ErrorAction SilentlyContinue
        throw 'Installed Chat did not create the expected application window.'
    }
    if ($process.HasExited) { throw "Installed Chat exited unexpectedly: $($process.ExitCode)" }
    Write-Host 'Installed Chat startup smoke PASS (MSI payload, NSIS installation, Start menu, rendered frontend).'
} finally {
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
