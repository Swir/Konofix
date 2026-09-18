function Get-KonofixPathComparison {
    if ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)) {
        return [System.StringComparison]::OrdinalIgnoreCase
    }
    return [System.StringComparison]::Ordinal
}

function Test-KonofixSameDirectory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right
    )

    $leftFull = [IO.Path]::GetFullPath($Left)
    $rightFull = [IO.Path]::GetFullPath($Right)
    return [string]::Equals($leftFull, $rightFull, (Get-KonofixPathComparison))
}
