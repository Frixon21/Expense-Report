# Creates biztech-mileage-deploy.zip with everything needed to build on the server.
# Run from the repo root:  .\scripts\package-for-deploy.ps1

[CmdletBinding()]
param(
  [string]$ProjectRoot = "",
  [string]$OutputZip = ""
)

$scriptDir = $PSScriptRoot
if (-not $scriptDir) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if (-not $ProjectRoot) {
  $ProjectRoot = (Resolve-Path (Join-Path $scriptDir "..")).Path
}

$ErrorActionPreference = "Stop"

if (-not $OutputZip) {
  $OutputZip = Join-Path $ProjectRoot "biztech-mileage-deploy.zip"
}

$include = @(
  "src",
  "public",
  "scripts",
  "package.json",
  "package-lock.json",
  "next.config.ts",
  "tsconfig.json",
  "next-env.d.ts"
)

$staging = Join-Path $env:TEMP ("biztech-mileage-deploy-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $staging -Force | Out-Null

try {
  foreach ($item in $include) {
    $source = Join-Path $ProjectRoot $item
    if (-not (Test-Path $source)) {
      throw "Missing required path: $source"
    }
    $dest = Join-Path $staging $item
    if (Test-Path $source -PathType Container) {
      Copy-Item -Path $source -Destination $dest -Recurse -Force
    } else {
      $parent = Split-Path $dest -Parent
      if (-not (Test-Path $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
      }
      Copy-Item -Path $source -Destination $dest -Force
    }
  }

  if (Test-Path $OutputZip) {
    Remove-Item $OutputZip -Force
  }

  Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $OutputZip -CompressionLevel Optimal

  $sizeMb = [math]::Round((Get-Item $OutputZip).Length / 1MB, 2)
  Write-Host "Created deploy package:"
  Write-Host "  $OutputZip"
  Write-Host "  $sizeMb MB"
  Write-Host ""
  Write-Host "Copy the zip to the server, extract into your deploy folder, then run:"
  Write-Host "  .\scripts\deploy.ps1"
}
finally {
  if (Test-Path $staging) {
    Remove-Item $staging -Recurse -Force
  }
}
