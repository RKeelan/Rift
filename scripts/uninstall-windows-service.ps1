<#
.SYNOPSIS
    Stops and removes the Rift Windows service.

.PARAMETER ServiceName
    Service name to remove. Defaults to "Rift".
#>
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$ServiceName = "Rift"
)

$ErrorActionPreference = "Stop"

$nssmCmd = Get-Command nssm.exe -ErrorAction SilentlyContinue
if (-not $nssmCmd) {
    throw "nssm.exe not found on PATH."
}
$nssm = $nssmCmd.Source

if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
    Write-Host "Service '$ServiceName' is not installed."
    return
}

Write-Host "Stopping '$ServiceName'..."
Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue

Write-Host "Removing '$ServiceName'..."
& $nssm remove $ServiceName confirm

Write-Host "Done."
