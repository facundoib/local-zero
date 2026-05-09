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
  Lemonade Server should be running (lemonade list / lemonade status). The
  script will check Lemonade's persistent ctx_size and bump it to 32K if
  the SPEC §F5 budget hasn't been set — this is one-shot, idempotent.

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
$ctxBudget = 32768   # SPEC §F5: 32K context budget for multi-turn RAG

# 0. Ensure Lemonade's persistent ctx_size is at least the SPEC §F5 budget.
#    Lemonade defaults to 4096, which overflows after ~3 RAG turns when each
#    turn carries ~3 KB of fragments. The setting is server-wide and persists
#    across restarts. Currently-loaded models keep their old ctx until they
#    are unloaded; we print the unload/load command in the warning so the
#    user can fix a stuck session without re-reading the issue. See #4.
$lemonadeCfg = $null
try {
    $lemonadeCfg = lemonade config 2>$null
} catch {
    # CLI unavailable; skip silently. Vite check or chat probe will surface it.
}
if ($lemonadeCfg) {
    $match = $lemonadeCfg | Select-String -Pattern '^\s*ctx_size\s+(\d+)' | Select-Object -First 1
    if ($match) {
        $current = [int]$match.Matches[0].Groups[1].Value
        if ($current -lt $ctxBudget) {
            Write-Host "[..] bumping Lemonade ctx_size $current -> $ctxBudget (SPEC F5 budget)"
            lemonade config set "ctx_size=$ctxBudget" | Out-Null
            Write-Warning "Loaded models keep the old ctx until reloaded. If a chat model is hot:"
            Write-Host  "       lemonade unload <model>; lemonade load <model>"
        } else {
            Write-Host "[ok] Lemonade ctx_size=$current"
        }
    }
}

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
