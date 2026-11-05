<#
.SYNOPSIS
  Place the offline electron-builder binaries into the Windows cache so
  `yarn dist:win` works without github.com access.

.DESCRIPTION
  Reads manifest.json (produced by fetch.mjs) alongside the 5 archives,
  verifies each sha256, and copies each archive into the cache directory
  that electron-builder / @electron/get expect. After this, the offline
  build skips every GitHub fetch.

  No environment variables, no hash reproduction, idempotent.

.PARAMETER BundleDir
  Directory containing manifest.json + the 5 archives (the output of
  fetch.mjs). Defaults to the current directory.

.EXAMPLE
  pwsh place.ps1
  pwsh place.ps1 -BundleDir C:\transfer\dsh-offline-win-bundle
#>
[CmdletBinding()]
param(
  [string]$BundleDir = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'

$manifestPath = Join-Path $BundleDir 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "manifest.json not found in BundleDir '$BundleDir'. Pass -BundleDir pointing at the bundle produced by fetch.mjs."
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

foreach ($entry in $manifest) {
  $src = Join-Path $BundleDir $entry.filename
  if (-not (Test-Path -LiteralPath $src)) {
    throw "archive missing in bundle: $($entry.filename)"
  }

  $hash = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash.ToLower()
  if ($hash -ne $entry.sha256.ToLower()) {
    throw "sha256 mismatch for $($entry.filename): expected $($entry.sha256), got $hash"
  }

  $cacheRoot = switch ($entry.cacheKind) {
    'electron' { Join-Path $env:LOCALAPPDATA 'electron\Cache' }
    'builder' { Join-Path $env:LOCALAPPDATA 'electron-builder\Cache' }
    default { throw "unknown cacheKind '$($entry.cacheKind)' for $($entry.filename)" }
  }
  $destDir = Join-Path $cacheRoot $entry.subdir
  $dest = Join-Path $destDir $entry.filename

  if (-not (Test-Path -LiteralPath $destDir)) {
    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
  }
  if (Test-Path -LiteralPath $dest) {
    Remove-Item -LiteralPath $dest -Force
  }
  Copy-Item -LiteralPath $src -Destination $dest -Force
  Write-Host ("placed  {0}  ->  {1}" -f $entry.filename, $dest)
}

Write-Host ""
Write-Host ("All {0} archives placed." -f $manifest.Count)
Write-Host "Next: yarn install --immutable, then yarn dist:win (from repo root)."
Write-Host "If electron-builder reports the electron binary is not installed, see README.md 'Fallback'."
