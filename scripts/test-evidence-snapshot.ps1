$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'evidence-snapshot.ps1')

function Expect-Reject([string]$Name, [scriptblock]$Action) {
    $rejected = $false
    try { & $Action } catch { $rejected = $true }
    if (-not $rejected) { throw "Expected rejection: $Name" }
    Write-Host "PASS (rejected): $Name"
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ('konofix-evidence-snapshot-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    $valid = Join-Path $temp 'valid.json'
    $payload = '{"schema":1,"status":"PASS","message":"snapshot-ok"}'
    [IO.File]::WriteAllText($valid, $payload, [Text.UTF8Encoding]::new($false))
    $snapshot = Read-KonofixBoundedJsonSnapshot -Path $valid -MaxBytes 4096 -Label 'fixture'
    $expectedBytes = [IO.File]::ReadAllBytes($valid)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $expectedHash = ([Convert]::ToHexString($sha.ComputeHash($expectedBytes))).ToLowerInvariant() } finally { $sha.Dispose() }
    if ([int64]$snapshot.Bytes -ne [int64]$expectedBytes.Length) { throw 'Snapshot byte count did not come from captured bytes.' }
    if ([string]$snapshot.Sha256 -cne $expectedHash) { throw 'Snapshot SHA-256 did not come from captured bytes.' }
    if ([int]$snapshot.Data.schema -ne 1 -or [string]$snapshot.Data.status -cne 'PASS') { throw 'Snapshot data parse mismatch.' }
    Write-Host 'PASS: exact-byte UTF-8 JSON snapshot captured, hashed and parsed.'

    $writer = [IO.File]::Open(
        $valid,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Write,
        [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
    )
    try {
        Expect-Reject 'snapshot while an in-place writer is active' {
            Read-KonofixBoundedJsonSnapshot -Path $valid -MaxBytes 4096 -Label 'fixture' | Out-Null
        }
    } finally {
        $writer.Dispose()
    }
    $postWriterSnapshot = Read-KonofixBoundedJsonSnapshot -Path $valid -MaxBytes 4096 -Label 'fixture'
    if ([string]$postWriterSnapshot.Sha256 -cne $expectedHash) { throw 'Snapshot did not recover after the writer handle was released.' }
    Write-Host 'PASS: writable evidence cannot be accepted as an exact snapshot.'

    $array = Join-Path $temp 'array.json'
    [IO.File]::WriteAllText($array, '[{"schema":1,"status":"PASS"}]', [Text.UTF8Encoding]::new($false))
    Expect-Reject 'array JSON root' { Read-KonofixBoundedJsonSnapshot -Path $array -MaxBytes 4096 -Label 'fixture' | Out-Null }

    $malformed = Join-Path $temp 'malformed.json'
    [IO.File]::WriteAllText($malformed, '{not-json', [Text.UTF8Encoding]::new($false))
    Expect-Reject 'malformed JSON' { Read-KonofixBoundedJsonSnapshot -Path $malformed -MaxBytes 4096 -Label 'fixture' | Out-Null }

    $invalidUtf8 = Join-Path $temp 'invalid-utf8.json'
    [IO.File]::WriteAllBytes($invalidUtf8, [byte[]](0x7b,0x22,0x78,0x22,0x3a,0x22,0xc3,0x28,0x22,0x7d))
    Expect-Reject 'invalid UTF-8' { Read-KonofixBoundedJsonSnapshot -Path $invalidUtf8 -MaxBytes 4096 -Label 'fixture' | Out-Null }

    $empty = Join-Path $temp 'empty.json'
    [IO.File]::WriteAllBytes($empty, [byte[]]@())
    Expect-Reject 'empty snapshot' { Read-KonofixBoundedJsonSnapshot -Path $empty -MaxBytes 4096 -Label 'fixture' | Out-Null }

    $oversized = Join-Path $temp 'oversized.json'
    [IO.File]::WriteAllText($oversized, '{"padding":"' + ('x' * 5000) + '"}', [Text.UTF8Encoding]::new($false))
    Expect-Reject 'oversized snapshot' { Read-KonofixBoundedJsonSnapshot -Path $oversized -MaxBytes 1024 -Label 'fixture' | Out-Null }

    if ($env:OS -ceq 'Windows_NT') {
        $sourceExecutable = [string](Get-Command cmd.exe -ErrorAction Stop).Source
        $lockedExecutable = Join-Path $temp 'konofix-lock-fixture.exe'
        Copy-Item -LiteralPath $sourceExecutable -Destination $lockedExecutable
        $expectedExecutableBytes = [int64](Get-Item -LiteralPath $lockedExecutable).Length
        $expectedExecutableHash = (Get-FileHash -LiteralPath $lockedExecutable -Algorithm SHA256).Hash.ToLowerInvariant()

        $activeWriter = [IO.File]::Open(
            $lockedExecutable,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Write,
            [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
        )
        try {
            Expect-Reject 'verified executable while an in-place writer is active' {
                Open-KonofixVerifiedExecutable -Path $lockedExecutable -ExpectedBytes $expectedExecutableBytes -ExpectedSha256 $expectedExecutableHash -Label 'fixture executable' | Out-Null
            }
        } finally {
            $activeWriter.Dispose()
        }

        $locked = Open-KonofixVerifiedExecutable -Path $lockedExecutable -ExpectedBytes $expectedExecutableBytes -ExpectedSha256 $expectedExecutableHash -Label 'fixture executable'
        try {
            if ([string]$locked.Sha256 -cne $expectedExecutableHash) { throw 'Executable lock SHA-256 mismatch.' }
            Expect-Reject 'writer while verified executable lock is active' {
                $blockedWriter = [IO.File]::Open(
                    $lockedExecutable,
                    [IO.FileMode]::Open,
                    [IO.FileAccess]::Write,
                    [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
                )
                $blockedWriter.Dispose()
            }
            Expect-Reject 'path replacement while verified executable lock is active' {
                Move-Item -LiteralPath $lockedExecutable -Destination (Join-Path $temp 'replacement-attempt.exe') -ErrorAction Stop
            }

            & $locked.Path /d /c 'exit 0' | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Locked executable failed to launch successfully: exit $LASTEXITCODE" }
            Write-Host 'PASS: verified executable remains launchable while writes and replacement are denied.'
        } finally {
            $locked.Stream.Dispose()
        }

        $postLockWriter = [IO.File]::Open(
            $lockedExecutable,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Write,
            [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
        )
        $postLockWriter.Dispose()
        $renamedExecutable = Join-Path $temp 'renamed-after-lock.exe'
        Move-Item -LiteralPath $lockedExecutable -Destination $renamedExecutable -ErrorAction Stop
        Move-Item -LiteralPath $renamedExecutable -Destination $lockedExecutable -ErrorAction Stop
        Write-Host 'PASS: executable writes/replacement recover after the verified lock is released.'
    }

    Write-Host 'Promotion evidence snapshot helper self-tests passed.'
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
