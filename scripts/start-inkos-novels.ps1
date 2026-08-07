param(
    [string]$ProjectRoot = "",
    [string]$Model = "gpt-5.6-terra"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $ProjectRoot) {
    $ProjectRoot = Join-Path $HOME "Documents\InkOS-Novels\codex-workspace"
}
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

function Set-DefaultModel([string]$Root, [string]$ModelId) {
    $configPath = Join-Path $Root "inkos.json"
    if (-not (Test-Path $configPath)) { return }
    try {
        $config = [System.IO.File]::ReadAllText($configPath) | ConvertFrom-Json
        if ($null -eq $config.llm) { return }
        $config.llm | Add-Member -NotePropertyName model -NotePropertyValue $ModelId -Force
        $config.llm | Add-Member -NotePropertyName defaultModel -NotePropertyValue $ModelId -Force
        Write-Utf8NoBom $configPath ($config | ConvertTo-Json -Depth 20)
        Write-Host "[InkOS Novels] Default model: $ModelId"
    }
    catch {
        Write-Warning "Could not update the existing default model; InkOS will keep its current selection."
    }
}

function Ensure-DesktopLauncher {
    try {
        $desktop = [Environment]::GetFolderPath("Desktop")
        if (-not $desktop) { return }
        $launcher = Join-Path $desktop "InkOS 小说助手.cmd"
        $thisScript = $MyInvocation.MyCommand.Path
        if (-not $thisScript) { $thisScript = Join-Path $PSScriptRoot "start-inkos-novels.ps1" }
        $content = "@echo off`r`nchcp 65001 >nul`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$thisScript`"`r`nif errorlevel 1 pause`r`n"
        [System.IO.File]::WriteAllText($launcher, $content, [System.Text.UTF8Encoding]::new($false))
        Write-Host "[InkOS Novels] Desktop launcher ready: $launcher"
    }
    catch {
        Write-Warning "Could not create the desktop launcher automatically."
    }
}

# If an existing instance is already alive, a double-click should simply reopen it.
try {
    $existing = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:4567" -TimeoutSec 1
    if ($existing.StatusCode -ge 200 -and $existing.StatusCode -lt 500) {
        Ensure-DesktopLauncher
        Start-Process "http://127.0.0.1:4567"
        Write-Host "[InkOS Novels] InkOS is already running; reopened Studio."
        exit 0
    }
}
catch { }

New-Item -ItemType Directory -Force -Path $ProjectRoot | Out-Null
Set-DefaultModel $ProjectRoot $Model
Ensure-DesktopLauncher

# v3 fiction-optimized bridge:
# - persistent Codex app-server
# - text-only agent instructions / no execution environment
# - Terra/Luna reasoning=none, Sol=low
# - per-request TTFT/latency diagnostics at http://127.0.0.1:43127/diagnostics
$env:INKOS_CODEX_APP_SERVER = "1"
$env:INKOS_CODEX_FAST_TEXT_MODE = "1"
Remove-Item Env:INKOS_CODEX_REASONING_EFFORT -ErrorAction SilentlyContinue

& (Join-Path $PSScriptRoot "start-inkos-codex.ps1") -ProjectRoot $ProjectRoot -Model $Model
exit $LASTEXITCODE
