param(
    [string]$ProjectRoot = "",
    [int]$StudioPort = 4567,
    [int]$BridgePort = 43127,
    [string]$Model = "gpt-5.6-sol"
)

$ErrorActionPreference = "Stop"

function Get-CommandPath([string]$Name) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $cmd) { return $null }
    return $cmd.Source
}

function Require-Success([string]$Label) {
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $ProjectRoot) {
    $ProjectRoot = Join-Path $HOME "Documents\InkOS-Novels\codex-workspace"
}
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)

Write-Host "[InkOS Codex] Repository: $repoRoot"
Write-Host "[InkOS Codex] Novel workspace: $ProjectRoot"

$node = Get-CommandPath "node.exe"
if (-not $node) { $node = Get-CommandPath "node" }
if (-not $node) {
    throw "Node.js 20+ is required."
}

$npm = Get-CommandPath "npm.cmd"
if (-not $npm) { $npm = Get-CommandPath "npm" }
if (-not $npm) {
    throw "npm is required. Reinstall Node.js if npm is missing."
}

$codex = Get-CommandPath "codex.cmd"
if (-not $codex) {
    throw "Codex CLI is required. Run scripts/bootstrap-codex-bridge.ps1 first."
}

$loginStatus = (& $codex login status 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $loginStatus -notmatch "Logged in using ChatGPT") {
    throw "Codex is not logged in with ChatGPT. Run 'codex login' and choose ChatGPT sign-in first."
}
Write-Host "[InkOS Codex] ChatGPT login: OK"

$pnpm = Get-CommandPath "pnpm.cmd"
if (-not $pnpm) {
    Write-Host "[InkOS Codex] Installing pnpm..."
    & $npm install -g pnpm@10
    Require-Success "pnpm installation"
    $pnpm = Get-CommandPath "pnpm.cmd"
}
if (-not $pnpm) {
    throw "pnpm was installed but is not visible in this PowerShell session. Reopen the terminal and rerun this script."
}

Push-Location $repoRoot
try {
    if (-not (Test-Path (Join-Path $repoRoot "node_modules"))) {
        Write-Host "[InkOS Codex] Installing InkOS workspace dependencies (first run only)..."
        & $pnpm install
        Require-Success "pnpm install"
    }

    $coreDist = Join-Path $repoRoot "packages\core\dist\index.js"
    if (-not (Test-Path $coreDist)) {
        Write-Host "[InkOS Codex] Building InkOS core (first run only)..."
        & $pnpm --filter "@actalk/inkos-core" build
        Require-Success "InkOS core build"
    }

    $studioIndex = Join-Path $repoRoot "packages\studio\dist\index.html"
    if (-not (Test-Path $studioIndex)) {
        Write-Host "[InkOS Codex] Building InkOS Studio frontend (first run only)..."
        & $pnpm --filter "@actalk/inkos-studio" build:client
        Require-Success "InkOS Studio frontend build"
    }

    New-Item -ItemType Directory -Force -Path $ProjectRoot | Out-Null
    $configPath = Join-Path $ProjectRoot "inkos.json"
    if (-not (Test-Path $configPath)) {
        $baseUrl = "http://127.0.0.1:$BridgePort/v1"
        $config = [ordered]@{
            name = "ChatGPT Plus Novel Workspace"
            version = "0.1.0"
            language = "zh"
            llm = [ordered]@{
                provider = "openai"
                service = "custom:ChatGPT Plus Codex"
                configSource = "studio"
                baseUrl = $baseUrl
                apiKey = ""
                model = $Model
                defaultModel = $Model
                temperature = 0.7
                thinkingBudget = 0
                apiFormat = "chat"
                stream = $true
                services = @(
                    [ordered]@{
                        service = "custom"
                        name = "ChatGPT Plus Codex"
                        baseUrl = $baseUrl
                        apiFormat = "chat"
                        stream = $true
                    }
                )
            }
        }
        $config | ConvertTo-Json -Depth 12 | Set-Content -Path $configPath -Encoding UTF8
        Write-Host "[InkOS Codex] Created preconfigured project: $configPath"
    }

    $env:INKOS_CODEX_BRIDGE_PORT = "$BridgePort"
    $env:INKOS_CODEX_MODEL = $Model
    $bridgeScript = Join-Path $repoRoot "scripts\codex-openai-bridge.mjs"
    Write-Host "[InkOS Codex] Starting local Codex bridge..."
    $bridge = Start-Process -FilePath $node -ArgumentList @($bridgeScript) -WorkingDirectory $repoRoot -PassThru -NoNewWindow

    try {
        $bridgeReady = $false
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Milliseconds 300
            try {
                $health = Invoke-RestMethod -Uri "http://127.0.0.1:$BridgePort/health" -TimeoutSec 2
                if ($health.ok) {
                    $bridgeReady = $true
                    break
                }
            } catch { }
            if ($bridge.HasExited) { break }
        }
        if (-not $bridgeReady) {
            throw "The local Codex bridge did not become ready on port $BridgePort."
        }
        Write-Host "[InkOS Codex] Bridge: OK"

        $env:INKOS_STUDIO_PORT = "$StudioPort"
        $env:INKOS_PROJECT_ROOT = $ProjectRoot
        $studioDir = Join-Path $repoRoot "packages\studio"
        Write-Host "[InkOS Codex] Starting InkOS Studio..."
        $studio = Start-Process -FilePath $pnpm -ArgumentList @("exec", "tsx", "src/api/index.ts", $ProjectRoot) -WorkingDirectory $studioDir -PassThru -NoNewWindow

        try {
            Start-Sleep -Seconds 3
            if ($studio.HasExited) {
                throw "InkOS Studio exited during startup."
            }

            $url = "http://127.0.0.1:$StudioPort"
            Write-Host ""
            Write-Host "=============================================================="
            Write-Host " InkOS + ChatGPT Plus is running"
            Write-Host " Studio: $url"
            Write-Host " Model:  $Model"
            Write-Host " Workspace: $ProjectRoot"
            Write-Host " Close this PowerShell window (or press Ctrl+C) to stop it."
            Write-Host "=============================================================="
            Write-Host ""
            Start-Process $url

            while (-not $studio.HasExited -and -not $bridge.HasExited) {
                Start-Sleep -Seconds 1
            }
            if ($bridge.HasExited -and -not $studio.HasExited) {
                throw "The Codex bridge stopped unexpectedly."
            }
        }
        finally {
            if ($studio -and -not $studio.HasExited) {
                Stop-Process -Id $studio.Id -Force -ErrorAction SilentlyContinue
            }
        }
    }
    finally {
        if ($bridge -and -not $bridge.HasExited) {
            Stop-Process -Id $bridge.Id -Force -ErrorAction SilentlyContinue
        }
    }
}
finally {
    Pop-Location
}
