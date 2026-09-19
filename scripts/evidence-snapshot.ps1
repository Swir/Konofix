function Read-KonofixBoundedJsonSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][ValidateRange(1024, 1048576)][int64]$MaxBytes,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label is missing: $Path"
    }

    $fullPath = [IO.Path]::GetFullPath($Path)
    $share = [System.IO.FileShare]::Read -bor [System.IO.FileShare]::Delete
    try {
        $stream = [System.IO.File]::Open(
            $fullPath,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            $share
        )
    } catch {
        throw "$Label could not be opened: $($_.Exception.GetBaseException().Message)"
    }

    try {
        if ($stream.Length -le 0) { throw "$Label is empty: $fullPath" }
        if ($stream.Length -gt $MaxBytes) {
            throw "$Label exceeds the maximum supported size of $MaxBytes bytes: $fullPath"
        }

        $buffer = [byte[]]::new([int]$MaxBytes + 1)
        $totalRead = 0
        while ($totalRead -lt $buffer.Length) {
            $read = $stream.Read($buffer, $totalRead, $buffer.Length - $totalRead)
            if ($read -eq 0) { break }
            $totalRead += $read
        }
        if ($totalRead -le 0) { throw "$Label is empty: $fullPath" }
        if ($totalRead -gt $MaxBytes) {
            throw "$Label exceeds the maximum supported size of $MaxBytes bytes: $fullPath"
        }

        $capturedBytes = [byte[]]::new($totalRead)
        [Array]::Copy($buffer, 0, $capturedBytes, 0, $totalRead)

        try {
            $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
            $raw = $utf8.GetString($capturedBytes)
        } catch {
            throw "$Label is not valid UTF-8: $($_.Exception.GetBaseException().Message)"
        }

        if (-not $raw.TrimStart().StartsWith('{', [System.StringComparison]::Ordinal)) {
            throw "$Label root must be a JSON object: $fullPath"
        }

        try {
            $convert = Get-Command ConvertFrom-Json -ErrorAction Stop
            $value = if ($convert.Parameters.ContainsKey('DateKind')) {
                $raw | ConvertFrom-Json -DateKind String
            } else {
                $raw | ConvertFrom-Json
            }
        } catch {
            throw "$Label is not valid JSON: $($_.Exception.Message)"
        }
        if ($value -isnot [pscustomobject]) {
            throw "$Label root must be a JSON object: $fullPath"
        }

        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $digest = $sha.ComputeHash($capturedBytes)
        } finally {
            $sha.Dispose()
        }
        $sha256 = ([Convert]::ToHexString($digest)).ToLowerInvariant()

        return [pscustomobject]@{
            Path = $fullPath
            Bytes = [int64]$totalRead
            Sha256 = $sha256
            ContentBytes = $capturedBytes
            Text = $raw
            Data = $value
        }
    } finally {
        $stream.Dispose()
    }
}

function Open-KonofixVerifiedExecutable {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][int64]$ExpectedBytes,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [string]$Label = 'Executable'
    )

    if ($ExpectedBytes -le 0) {
        throw "$Label expected byte count must be positive."
    }
    if ($ExpectedSha256 -cnotmatch '^[0-9a-f]{64}$') {
        throw "$Label expected SHA-256 must be canonical lowercase hexadecimal."
    }

    $fullPath = [IO.Path]::GetFullPath($Path)
    try {
        # FileShare.Read permits process-loader reads while denying writers and
        # delete/rename attempts for the full lifetime of the returned stream.
        $stream = [System.IO.File]::Open(
            $fullPath,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read
        )
    } catch {
        throw "$Label could not be locked against writes/replacement: $($_.Exception.GetBaseException().Message)"
    }

    try {
        if ([int64]$stream.Length -ne $ExpectedBytes) {
            throw "$Label size does not match the verified build manifest: $fullPath"
        }

        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $digest = $sha.ComputeHash($stream)
        } finally {
            $sha.Dispose()
        }
        $actualSha256 = ([Convert]::ToHexString($digest)).ToLowerInvariant()
        $stream.Position = 0

        if (-not [string]::Equals($actualSha256, $ExpectedSha256, [StringComparison]::Ordinal)) {
            throw "$Label SHA-256 does not match the verified build manifest: $fullPath"
        }

        return [pscustomobject]@{
            Path = $fullPath
            Bytes = [int64]$stream.Length
            Sha256 = $actualSha256
            Stream = $stream
        }
    } catch {
        $stream.Dispose()
        throw
    }
}
