<#
.SYNOPSIS
    Installs Rift as a Windows service via NSSM.

.DESCRIPTION
    Registers the built server (`server\dist\index.js`) as a Windows service
    under the supplied user account, configures auto-restart, and redirects
    stdout/stderr to rotating log files under `logs\`.

    Run `bun run build` before invoking this script.

.PARAMETER ReposRoot
    Absolute path to the directory that holds your repositories. Required.

.PARAMETER ServiceName
    Service name to register. Defaults to "Rift".

.PARAMETER Port
    Port to bind. Defaults to 13000.

.PARAMETER BindAddress
    Address to bind (sets the HOST env var). Defaults to 127.0.0.1. Use
    0.0.0.0 only if you are NOT fronting the service with `tailscale serve`
    or a similar reverse proxy.

.PARAMETER LogonUser
    User account to run the service as, e.g. ".\yourname" or "DOMAIN\user".
    The script prompts for the password securely. If omitted, the service
    runs as LocalSystem (NOT RECOMMENDED -- the API would inherit write
    access to the entire disk).

.EXAMPLE
    .\scripts\install-windows-service.ps1 -ReposRoot C:\Users\me\Src -LogonUser .\me
#>
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReposRoot,

    [string]$ServiceName = "Rift",
    [int]$Port = 13000,
    [string]$BindAddress = "127.0.0.1",
    [string]$LogonUser
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$serverEntry = Join-Path $repoRoot "server\dist\index.js"
$logDir = Join-Path $repoRoot "logs"

$bunCmd = Get-Command bun.exe -ErrorAction SilentlyContinue
if (-not $bunCmd) {
    throw "bun.exe not found on PATH. Install Bun from https://bun.sh first."
}
$bun = $bunCmd.Source

$nssmCmd = Get-Command nssm.exe -ErrorAction SilentlyContinue
if (-not $nssmCmd) {
    throw "nssm.exe not found on PATH. Install NSSM from https://nssm.cc and add it to PATH."
}
$nssm = $nssmCmd.Source

if (-not (Test-Path $serverEntry)) {
    throw "Build output not found at $serverEntry. Run 'bun run build' first."
}

if (-not (Test-Path -LiteralPath $ReposRoot -PathType Container)) {
    throw "REPOS_ROOT does not exist or is not a directory: $ReposRoot"
}

if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    throw "Service '$ServiceName' already exists. Run uninstall-windows-service.ps1 first."
}

Write-Host "Installing service '$ServiceName'..."

& $nssm install $ServiceName $bun $serverEntry
& $nssm set $ServiceName AppDirectory $repoRoot
& $nssm set $ServiceName Description "Rift mobile-friendly local repo browser"
& $nssm set $ServiceName Start SERVICE_AUTO_START
& $nssm set $ServiceName AppExit Default Restart
& $nssm set $ServiceName AppRestartDelay 5000

$envLines = @(
    "REPOS_ROOT=$ReposRoot",
    "PORT=$Port",
    "HOST=$BindAddress"
)
& $nssm set $ServiceName AppEnvironmentExtra $envLines

& $nssm set $ServiceName AppStdout (Join-Path $logDir "rift.out.log")
& $nssm set $ServiceName AppStderr (Join-Path $logDir "rift.err.log")
& $nssm set $ServiceName AppRotateFiles 1
& $nssm set $ServiceName AppRotateOnline 1
& $nssm set $ServiceName AppRotateBytes 10485760

if ($LogonUser) {
    $secure = Read-Host -Prompt "Password for $LogonUser" -AsSecureString
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        & $nssm set $ServiceName ObjectName $LogonUser $plain
    } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
} else {
    Write-Warning "No -LogonUser supplied; service will run as LocalSystem."
    Write-Warning "Re-run with -LogonUser '.\yourname' to constrain its filesystem access."
}

Write-Host ""
Write-Host "Service '$ServiceName' installed."
Write-Host "  Bun:        $bun"
Write-Host "  Repo root:  $repoRoot"
Write-Host "  REPOS_ROOT: $ReposRoot"
Write-Host "  Bind:       ${BindAddress}:${Port}"
Write-Host "  Logs:       $logDir"
Write-Host ""
Write-Host "Start with:  Start-Service $ServiceName"
Write-Host "Status with: Get-Service  $ServiceName"
