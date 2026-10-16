# Install, build, and (optionally) start the Expense Report app on the server.
# Run from the app folder after extracting the deploy zip:
#   .\scripts\deploy.ps1
#   .\scripts\deploy.ps1 -StartServer
#   .\scripts\deploy.ps1 -StartServer -Port 3001

[CmdletBinding()]
param(
  [string]$AppRoot = "",
  [string]$BindHost = "0.0.0.0",
  [int]$Port = 3001,
  [switch]$StartServer,
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
if (-not $scriptDir) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if (-not $AppRoot) {
  $AppRoot = (Resolve-Path (Join-Path $scriptDir "..")).Path
}

function Invoke-Step {
  param([string]$Label, [scriptblock]$Action)
  Write-Host ""
  Write-Host "==> $Label"
  & $Action
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed (exit $LASTEXITCODE)"
  }
}

Push-Location $AppRoot
try {
  Write-Host "Deploy root: $AppRoot"
  Write-Host "Node: $(node -v)"
  Write-Host "npm:  $(npm -v)"

  if (-not $SkipInstall) {
    Invoke-Step "npm ci" { npm ci }
  }

  Invoke-Step "npm run build" { npm run build }

  Write-Host ""
  Write-Host "Deploy build finished successfully."
  Write-Host "LAN URL (if firewall allows): http://<server-ip>:$Port"

  if ($StartServer) {
    Write-Host ""
    Write-Host "==> Starting Next.js on $BindHost`:$Port (Ctrl+C to stop)"
    npx next start --hostname $BindHost --port $Port
    if ($LASTEXITCODE -ne 0) {
      throw "next start failed (exit $LASTEXITCODE)"
    }
  } else {
    Write-Host ""
    Write-Host "To start the app:"
    Write-Host "  npx next start --hostname $BindHost --port $Port"
    Write-Host "Or re-run:"
    Write-Host "  .\scripts\deploy.ps1 -StartServer -Port $Port"
  }
}
finally {
  Pop-Location
}
