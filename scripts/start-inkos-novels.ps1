param(
    [string]$ProjectRoot = "",
    [string]$Model = "gpt-5.6-luna",
    [string]$CodexHome = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $ProjectRoot) {
    $ProjectRoot = Join-Path $HOME "Documents\InkOS-Novels\codex-workspace"
}
if (-not $CodexHome) {
    $CodexHome = Join-Path $HOME "Documents\InkOS-Novels\codex-home"
}
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$CodexHome = [System.IO.Path]::GetFullPath($CodexHome)

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

function Get-CommandPath([string]$Name) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $cmd) { return $null }
    return $cmd.Source
}

function Invoke-NativeCapture([string]$FilePath, [string[]]$Arguments) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.Arguments = ($Arguments | ForEach-Object {
        if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
    }) -join ' '

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    if (-not $process.Start()) { throw "Failed to start native command: $FilePath" }
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    return [pscustomobject]@{
        ExitCode = $process.ExitCode
        Combined = (($stdout + "`n" + $stderr).Trim())
    }
}

function Ensure-IsolatedCodexLogin([string]$HomePath) {
    $codex = Get-CommandPath "codex.cmd"
    if (-not $codex) { throw "Codex CLI is required." }

    $probe = Invoke-NativeCapture $codex @("login", "status")
    if ($probe.ExitCode -eq 0 -and $probe.Combined -match "Logged in using ChatGPT") {
        Write-Host "[InkOS Novels] Isolated ChatGPT login: OK"
        return
    }

    Write-Host "[InkOS Novels] One-time ChatGPT login is required for the isolated novel-writing Codex environment."
    Write-Host "[InkOS Novels] Complete the ChatGPT sign-in in the browser window that opens."
    $login = Start-Process -FilePath $codex -ArgumentList @("login") -Wait -PassThru -NoNewWindow
    if ($login.ExitCode -ne 0) {
        throw "Codex login for the isolated novel-writing environment failed with exit code $($login.ExitCode)."
    }

    $probe = Invoke-NativeCapture $codex @("login", "status")
    if ($probe.ExitCode -ne 0 -or $probe.Combined -notmatch "Logged in using ChatGPT") {
        throw "The isolated novel-writing Codex environment is still not logged in."
    }
    Write-Host "[InkOS Novels] Isolated ChatGPT login: OK"
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

function Get-SkillVersion([string]$ManifestPath) {
    if (-not (Test-Path $ManifestPath)) { return $null }
    try {
        $text = [System.IO.File]::ReadAllText($ManifestPath)
        $match = [regex]::Match($text, '(?m)^version:\s*([0-9]+(?:\.[0-9]+){1,3})\s*$')
        if (-not $match.Success) { return $null }
        return [version]$match.Groups[1].Value
    }
    catch {
        return $null
    }
}

function Install-NovelsSkillPresets([string]$Root) {
    $sourceRoot = Join-Path $repoRoot "presets\novel-skills"
    if (-not (Test-Path $sourceRoot)) { return }

    $targetRoot = Join-Path $Root ".agents\skills"
    $backupRoot = Join-Path $Root ".agents\skill-backups"
    New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null

    $installed = @()
    $updated = @()
    $preserved = @()

    Get-ChildItem -Path $sourceRoot -Directory | ForEach-Object {
        $skillName = $_.Name
        $sourceSkill = $_.FullName
        $sourceManifest = Join-Path $sourceSkill "SKILL.md"
        $targetSkill = Join-Path $targetRoot $skillName
        $targetManifest = Join-Path $targetSkill "SKILL.md"

        if (-not (Test-Path $targetManifest)) {
            New-Item -ItemType Directory -Force -Path $targetSkill | Out-Null
            Copy-Item -Path (Join-Path $sourceSkill "*") -Destination $targetSkill -Recurse -Force
            $installed += $skillName
            return
        }

        $sourceVersion = Get-SkillVersion $sourceManifest
        $targetVersion = Get-SkillVersion $targetManifest

        # Versioned presets can upgrade an older installed preset. Back up the
        # entire old skill first so local customizations are never destroyed.
        # Same-version local edits are preserved on normal restarts.
        if ($null -ne $sourceVersion -and $null -ne $targetVersion -and $sourceVersion -gt $targetVersion) {
            New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
            $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
            $backupSkill = Join-Path $backupRoot ("{0}-v{1}-{2}" -f $skillName, $targetVersion, $timestamp)
            Copy-Item -Path $targetSkill -Destination $backupSkill -Recurse -Force
            Copy-Item -Path (Join-Path $sourceSkill "*") -Destination $targetSkill -Recurse -Force
            $updated += ("{0} {1}->{2}" -f $skillName, $targetVersion, $sourceVersion)
        }
        else {
            $preserved += $skillName
        }
    }

    if ($installed.Count -gt 0) {
        Write-Host "[InkOS Novels] Installed writing skills: $($installed -join ', ')"
    }
    if ($updated.Count -gt 0) {
        Write-Host "[InkOS Novels] Updated writing skills (old copies backed up): $($updated -join ', ')"
    }
    if ($installed.Count -eq 0 -and $updated.Count -eq 0) {
        Write-Host "[InkOS Novels] Writing skill presets already current; same-version user edits preserved."
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
New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null
Install-NovelsSkillPresets $ProjectRoot

# Keep novel-writing Codex state isolated from the user's normal VS Code/Codex
# state. This prevents accumulated coding sessions, MCP servers, project rules,
# and other developer-oriented state under ~/.codex from being loaded into each
# InkOS fiction thread. Authentication is performed once for this isolated home.
$env:CODEX_HOME = $CodexHome
Write-Host "[InkOS Novels] Isolated CODEX_HOME: $CodexHome"
Ensure-IsolatedCodexLogin $CodexHome

Set-DefaultModel $ProjectRoot $Model
Ensure-DesktopLauncher

# Fiction bridge policy:
# - Luna is the default low-latency drafting model.
# - Terra remains available for stronger planning/revision.
# - Sol remains available for the hardest story decisions.
# - persistent Codex app-server + per-request latency diagnostics.
$env:INKOS_CODEX_APP_SERVER = "1"
$env:INKOS_CODEX_FAST_TEXT_MODE = "1"
Remove-Item Env:INKOS_CODEX_REASONING_EFFORT -ErrorAction SilentlyContinue

& (Join-Path $PSScriptRoot "start-inkos-codex.ps1") -ProjectRoot $ProjectRoot -Model $Model
exit $LASTEXITCODE
