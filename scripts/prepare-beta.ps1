$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_REPOSITORY -cne 'Swir/Konofix' -or $env:GITHUB_REF -cne 'refs/heads/main' -or $env:GITHUB_EVENT_NAME -cne 'push') {
    throw 'Beta preparation requires a trusted main push in Swir/Konofix.'
}
$commit = $env:GITHUB_SHA
if ($commit -cnotmatch '^[0-9a-f]{40}$') { throw 'Invalid source commit.' }
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
if ($version -cne '0.4.4') { throw 'This beta intent belongs to version 0.4.4.' }
$tag = 'v0.4.4-beta.1'
$name = "Konofix-Chat-$version-Windows-$commit.zip"
$archive = Join-Path 'downloaded' $name
& (Join-Path $PSScriptRoot 'verify-release.ps1') -ZipPath $archive -ChecksumPath "$archive.sha256"

$output = New-Item -ItemType Directory -Path 'beta-release'
$zip = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $archive).Path)
try {
    $infoPath = Join-Path $output.FullName 'BUILD_INFO.json'
    [IO.Compression.ZipFileExtensions]::ExtractToFile($zip.GetEntry('BUILD_INFO.json'), $infoPath, $false)
    $info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
    if ($info.commit -cne $commit -or $info.version -cne $version -or $info.workflow_run -cne $env:GITHUB_RUN_ID) {
        throw 'Beta artifact must come from this exact main build and workflow.'
    }
    $installerName = 'Konofix-Chat-0.4.4-beta.1-setup.exe'
    $installerPath = Join-Path $output.FullName $installerName
    $source = 'bundle/nsis/Konofix Chat_0.4.4_x64-setup.exe'
    $meta = @($info.installers | Where-Object path -CEQ $source)
    if ($meta.Count -ne 1) { throw 'Expected exactly one Chat setup executable.' }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($zip.GetEntry($source), $installerPath, $false)
    $hash = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -cne $meta[0].sha256 -or (Get-Item -LiteralPath $installerPath).Length -ne $meta[0].bytes) {
        throw 'Installer does not match sealed build metadata.'
    }
    [IO.File]::WriteAllText("$installerPath.sha256", "$hash  $installerName`n", [Text.UTF8Encoding]::new($false))
} finally { $zip.Dispose() }
Copy-Item -LiteralPath $archive, "$archive.sha256" -Destination $output.FullName
$files = @(Get-ChildItem -LiteralPath $output.FullName -File | Sort-Object Name | ForEach-Object {
    [ordered]@{ name = $_.Name; bytes = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
})
$notes = Get-Content 'docs/RELEASE_0.4.4_BETA1.md' -Raw
$body = $notes.Trim() + "`n`nSource commit: ``$commit```nWindows build and installed GUI verification: https://github.com/Swir/Konofix/actions/runs/$env:GITHUB_RUN_ID`n`nSHA-256:`n"
foreach ($file in $files) { $body += "`n- ``$($file.name)``: ``$($file.sha256)``" }
$plan = [ordered]@{ tag = $tag; version = $version; commit = $commit; workflow_run = $env:GITHUB_RUN_ID; body = $body; files = $files }
[IO.File]::WriteAllText((Join-Path $output.FullName 'plan.json'), ($plan | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
Write-Host "Prepared $tag with $($files.Count) verified files from $commit."
