<#
.SYNOPSIS
    Exposes the local Rift port over the tailnet via `tailscale serve`.

.DESCRIPTION
    `tailscale serve --bg` saves the configuration to Tailscale's persistent
    state, so this only needs to be run once per machine. To remove, run:

        tailscale serve --bg <port> off

.PARAMETER Port
    Local port to forward. Defaults to 13000.
#>
[CmdletBinding()]
param(
    [int]$Port = 13000
)

$ErrorActionPreference = "Stop"

$tailscaleCmd = Get-Command tailscale.exe -ErrorAction SilentlyContinue
if (-not $tailscaleCmd) {
    throw "tailscale.exe not found on PATH. Install Tailscale from https://tailscale.com/download."
}
$tailscale = $tailscaleCmd.Source

& $tailscale status > $null 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "Tailscale is not running or not signed in. Run 'tailscale up' first."
}

Write-Host "Configuring tailscale serve for localhost:$Port..."
& $tailscale serve --bg $Port
if ($LASTEXITCODE -ne 0) {
    throw "tailscale serve failed (exit $LASTEXITCODE)."
}

Write-Host ""
Write-Host "Active serve config:"
& $tailscale serve status
