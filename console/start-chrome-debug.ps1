# start-chrome-debug.ps1
# Starts Chrome with a remote-debugging port so the locate console (server.mjs)
# can attach to it via CDP and reuse ALL logged-in tokens of this browser profile.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File console\start-chrome-debug.ps1
#
# Notes:
#   - If Chrome is already running WITHOUT the debug port, you must close it
#     first (this script will ask), otherwise Chrome just forwards the flag to
#     the running instance and the port never opens.
#   - Chrome 136+ IGNORES --remote-debugging-port on the DEFAULT user profile
#     (security hardening). This script therefore uses a dedicated debug
#     profile directory. Log in once inside that window; the session persists
#     in that profile for all future runs (same as persistent mode, but you
#     can see and share the browser window).

param(
  [int]$Port = 9222,
  [switch]$ForceClose
)

$ErrorActionPreference = 'Stop'

# ---- 0. already listening? ----
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  try {
    $v = Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 5
    Write-Host "[OK] Chrome debug port $Port already active: $($v.Browser)"
    Write-Host "     Now start the console: pnpm console"
    exit 0
  } catch {
    Write-Host "[WARN] Port $Port occupied but not a Chrome debugger; continuing."
  }
}

# ---- 1. locate chrome.exe ----
$chromeCandidates = @(
  (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' -ErrorAction SilentlyContinue).'(default)',
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $chromeCandidates) { Write-Host "[ERR] chrome.exe not found."; exit 1 }
Write-Host "[i] Chrome: $chromeCandidates"

# ---- 2. ensure no running Chrome instance (would swallow the flag) ----
$chromeProcs = Get-Process chrome -ErrorAction SilentlyContinue
if ($chromeProcs) {
  if (-not $ForceClose) {
    Write-Host "[!] Chrome is currently running ($($chromeProcs.Count) processes)."
    Write-Host "    A running instance forwards the debug flag and the port never opens."
    Write-Host "    Close all Chrome windows, or re-run with -ForceClose to terminate them."
    $resp = Read-Host "Close all Chrome processes now? (y/N)"
    if ($resp -notmatch '^[Yy]') { Write-Host "[ABORT] user declined."; exit 1 }
  }
  $chromeProcs | Stop-Process -Force
  Start-Sleep -Seconds 2
  Write-Host "[OK] Chrome closed."
}

# ---- 3. dedicated debug profile (Chrome 136+ ignores debug port on default profile) ----
$debugProfile = Join-Path $env:LOCALAPPDATA 'ChromeDebugProfile'
New-Item -ItemType Directory -Force -Path $debugProfile | Out-Null

# ---- 4. launch ----
Start-Process -FilePath $chromeCandidates -ArgumentList @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=`"$debugProfile`"",
  '--no-first-run', '--no-default-browser-check'
)
Write-Host "[i] Chrome launching with debug profile: $debugProfile"

# ---- 5. verify the debug endpoint is really up ----
$deadline = (Get-Date).AddSeconds(20)
$ok = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 800
  try {
    $v = Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 3
    $ok = $true; break
  } catch {}
}
if ($ok) {
  Write-Host "[OK] Chrome debug endpoint verified: http://127.0.0.1:$Port/json/version ($($v.Browser))"
  Write-Host "     Log in to your target systems in THIS window once; the session persists"
  Write-Host "     in the debug profile across restarts."
  Write-Host "     Now start the console:  pnpm console"
  exit 0
} else {
  Write-Host "[ERR] debug port did not open within 20s."
  Write-Host "      Fallback: keep default incognito mode (remove CONSOLE_CDP_URL from .env),"
  Write-Host "      or use persistent profile mode (CONSOLE_USER_DATA_DIR in .env)."
  exit 1
}
