param()

$ErrorActionPreference = 'Stop'
$editor = Join-Path $PSScriptRoot 'set-network-test-result.ps1'
if (-not (Test-Path -LiteralPath $editor -PathType Leaf)) { throw 'Network report editor not found.' }

$temp = Join-Path ([IO.Path]::GetTempPath()) ("konofix-network-report-editor-selftest-" + [Guid]::NewGuid().ToString('N'))
$manifest = Join-Path $temp 'network-test-relay.json'
$incomplete = Join-Path $temp 'network-test-incomplete.json'
$evidenceMissing = Join-Path $temp 'network-test-evidence-missing.json'
$sourceCommit = '0123456789abcdef0123456789abcdef01234567'
$fileHashA = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
$fileHashB = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
$checks = @('world_a_to_b','world_b_to_a','room_discovery','file_a_to_b_sha256','file_b_to_a_sha256','client_reconnect','node_restart_recovery','relay_observed','dcutr_direct_upgrade','nickname_conflict')

function New-Manifest([string]$Path) {
    $checkObject = [ordered]@{}
    foreach ($name in $checks) { $checkObject[$name] = 'PENDING' }
    [ordered]@{
        schema_version = 3
        created_utc = [DateTimeOffset]::UtcNow.ToString('o')
        scenario = 'Relay'
        build_version = '0.4.2'
        node_version = '0.4.2'
        source_commit = $sourceCommit
        client_a = 'PC-A'
        client_b = 'PC-B'
        client_a_country = 'Norway'
        client_b_country = 'Poland'
        client_a_network = 'Operator-A'
        client_b_network = 'Operator-B'
        bootstrap = '/dns/node.example.net/tcp/45555/p2p/12D3KooWEditorStablePeer123456789'
        notes = 'self-test'
        overall = 'PENDING'
        checks = $checkObject
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Path -Encoding utf8
}

function Set-Result([string]$Name, [string]$Value = 'PASS', [string]$Evidence = 'verified observation', [switch]$Finalize, [switch]$AllowOverwrite) {
    $args = @{
        Manifest = $manifest
        Check = $Name
        Result = $Value
        Evidence = $Evidence
    }
    if ($Finalize) { $args.Finalize = $true }
    if ($AllowOverwrite) { $args.AllowOverwrite = $true }
    & $editor @args
}

function Assert-Rejected([scriptblock]$Action, [string]$Name) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true; Write-Host "Expected rejection passed: $Name" }
    if (-not $rejected) { throw "Negative network report editor self-test was accepted unexpectedly: $Name" }
}

try {
    New-Item -ItemType Directory -Force -Path $temp | Out-Null
    New-Manifest $manifest

    foreach ($name in @('world_a_to_b','world_b_to_a','room_discovery','file_a_to_b_sha256','file_b_to_a_sha256','client_reconnect','node_restart_recovery','relay_observed')) {
        $evidence = switch ($name) {
            'file_a_to_b_sha256' { "sender/receiver sha256=$fileHashA" }
            'file_b_to_a_sha256' { "sender/receiver sha256=$fileHashB" }
            default { "evidence-$name" }
        }
        Set-Result -Name $name -Evidence $evidence | Out-Null
    }
    Set-Result -Name 'nickname_conflict' -Evidence 'duplicate nick rejected' -Finalize | Out-Null

    $data = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    if ($data.overall -ne 'PASS') { throw "Completed Relay report should be PASS, found $($data.overall)." }
    if ($data.checks.relay_observed -ne 'PASS') { throw 'Relay scenario did not retain relay_observed=PASS.' }
    if ([string]$data.check_evidence.nickname_conflict -ne 'duplicate nick rejected') { throw 'Per-check evidence was not persisted.' }
    if ([string]$data.check_evidence.file_a_to_b_sha256 -notmatch [regex]::Escape($fileHashA)) { throw 'File-transfer evidence did not retain the observed SHA-256 digest.' }
    $markdown = [IO.Path]::ChangeExtension($manifest, '.md')
    if (-not (Test-Path -LiteralPath $markdown -PathType Leaf)) { throw 'Editor did not regenerate the Markdown report.' }
    $markdownText = Get-Content -LiteralPath $markdown -Raw
    if ($markdownText -notmatch 'Overall: \*\*PASS\*\*' -or $markdownText -notmatch 'duplicate nick rejected' -or $markdownText -notmatch [regex]::Escape($fileHashA)) { throw 'Markdown report is not synchronized with JSON evidence.' }

    Assert-Rejected { Set-Result -Name 'world_a_to_b' -Value 'FAIL' -Evidence 'replacement without opt-in' } 'overwrite without explicit opt-in'
    $afterRejectedOverwrite = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    if ($afterRejectedOverwrite.checks.world_a_to_b -ne 'PASS') { throw 'Rejected overwrite modified authoritative evidence.' }

    Set-Result -Name 'world_a_to_b' -Value 'FAIL' -Evidence 'intentional regression' -AllowOverwrite | Out-Null
    $failed = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    if ($failed.overall -ne 'FAIL') { throw 'A failed promotion check must force overall=FAIL.' }
    Set-Result -Name 'world_a_to_b' -Value 'PASS' -Evidence 'retested successfully' -AllowOverwrite -Finalize | Out-Null

    New-Manifest $incomplete
    Assert-Rejected { & $editor -Manifest $incomplete -Check world_a_to_b -Result PASS -Evidence 'only one check' -Finalize } 'premature finalization'
    $stillIncomplete = Get-Content -LiteralPath $incomplete -Raw | ConvertFrom-Json
    if ($stillIncomplete.overall -ne 'PENDING' -or $stillIncomplete.checks.world_a_to_b -ne 'PENDING') { throw 'Failed finalization must not modify the source manifest.' }

    New-Manifest $evidenceMissing
    Assert-Rejected { & $editor -Manifest $evidenceMissing -Check world_a_to_b -Result PASS -Evidence '' } 'PASS without evidence note'
    Assert-Rejected { & $editor -Manifest $evidenceMissing -Check world_a_to_b -Result FAIL -Evidence '   ' } 'FAIL without evidence note'
    Assert-Rejected { & $editor -Manifest $evidenceMissing -Check file_a_to_b_sha256 -Result PASS -Evidence 'hashes matched' } 'file PASS without explicit SHA-256 digest'
    Assert-Rejected { & $editor -Manifest $evidenceMissing -Check file_b_to_a_sha256 -Result PASS -Evidence 'sha256=deadbeef' } 'file PASS with malformed SHA-256 digest'
    $afterEvidenceRejections = Get-Content -LiteralPath $evidenceMissing -Raw | ConvertFrom-Json
    if ($afterEvidenceRejections.checks.world_a_to_b -ne 'PENDING' -or $afterEvidenceRejections.checks.file_a_to_b_sha256 -ne 'PENDING') { throw 'Rejected evidence update modified the source manifest.' }

    $scratch = @(Get-ChildItem -LiteralPath $temp -File | Where-Object { $_.Name -like '.network-*' })
    if ($scratch.Count -ne 0) { throw 'Editor left temporary files after self-tests.' }

    Write-Host 'Network report editor self-tests passed.'
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
