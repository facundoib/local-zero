#requires -Version 5.1
<#
Build the Tauri backend and launch it detached from cargo's process tree.

Why this exists:
  `npm run tauri dev` invokes `cargo run`, which spawns the .exe as a child of cargo.
  On Windows hosts where Smart App Control is enforcing, that child launch is blocked
  with `os error 4551` (ERROR_BLOCKED_BY_APP_CONTROL_POLICY). Launching the same
  binary directly from the user's shell via Start-Process is not blocked, because
  SAC evaluates by process lineage, not by file hash or signature on this path.

Prerequisite:
  Vite must be running. In another terminal: `npm run dev` (serves on :1420).

Usage:
  .\scripts\dev.ps1            # build + launch
  .\scripts\dev.ps1 -SkipBuild  # only relaunch (assumes binary is current)
#>

[CmdletBinding()]
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$root    = Split-Path -Parent $PSScriptRoot
$srcTauri = Join-Path $root "src-tauri"
$exe     = Join-Path $srcTauri "target\debug\local-zero.exe"
$viteUrl = "http://localhost:1420/"

# 1. Verify Vite is up — otherwise WebView2 will show a localhost-refused page.
try {
    Invoke-WebRequest -Uri $viteUrl -UseBasicParsing -TimeoutSec 2 | Out-Null
    Write-Host "[ok] Vite reachable on $viteUrl"
} catch {
    Write-Warning "Vite not reachable on $viteUrl"
    Write-Host  "       Start it in another terminal: npm run dev"
    exit 1
}

# 2. Stop any running instance so we relaunch the fresh build.
Get-Process local-zero -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "[..] stopping running local-zero (PID $($_.Id))"
    Stop-Process -Id $_.Id -Force
    Start-Sleep -Milliseconds 200
}

# 3. Build with the same feature set tauri-cli uses for dev.
if (-not $SkipBuild) {
    Write-Host "[..] cargo build --no-default-features"
    Push-Location $srcTauri
    try {
        cargo build --no-default-features
        if ($LASTEXITCODE -ne 0) {
            throw "cargo build failed (exit $LASTEXITCODE)"
        }
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path $exe)) {
    throw "Binary not found: $exe"
}

# 4. Launch detached. Start-Process makes the user shell the parent, not cargo.
Write-Host "[..] launching $exe"
Start-Process -FilePath $exe
Write-Host "[ok] Local Zero running detached. Stop with: Stop-Process -Name local-zero"
