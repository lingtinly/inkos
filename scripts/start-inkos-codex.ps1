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
    if (-not $process.Start()) {
        throw "Failed to start native command: $FilePath"
    }

    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()

    return [pscustomobject]@{
        ExitCode = $process.ExitCode
        Stdout = $stdout
        Stderr = $stderr
        Combined = (($stdout + "`n" + $stderr).Trim())
    }
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

function New-BridgeProjectConfig([string]$BaseUrl, [string]$ModelId) {
    return [ordered]@{
        name = "ChatGPT Plus Novel Workspace"
        version = "0.1.0"
        language = "zh"
        llm = [ordered]@{
            provider = "openai"
            service = "custom:ChatGPT Plus Codex"
            configSource = "studio"
            baseUrl = $BaseUrl
            apiKey = ""
            model = $ModelId
            defaultModel = $ModelId
            temperature = 0.7
            thinkingBudget = 0
            apiFormat = "chat"
            stream = $true
            services = @(
                [ordered]@{
                    service = "custom"
                    name = "ChatGPT Plus Codex"
                    baseUrl = $BaseUrl
                    apiFormat = "chat"
                    stream = $true
                }
            )
        }
    }
}

function Save-BridgeProjectConfig([string]$Path, [string]$BaseUrl, [string]$ModelId) {
    $config = New-BridgeProjectConfig $BaseUrl $ModelId
    $json = $config | ConvertTo-Json -Depth 12
    Write-Utf8NoBom $Path $json
}

function Ensure-BridgeSecret([string]$Root) {
    # InkOS Studio resolves credentials from .inkos/secrets.json even when the
    # selected endpoint is local and does not actually require authentication.
    # pi-ai's OpenAI transport still refuses an empty key before it sends the
    # localhost request, so keep a harmless local-only placeholder credential.
    $serviceKey = "custom:ChatGPT Plus Codex"
    $placeholderKey = "local-codex-bridge"
    $secretsDir = Join-Path $Root ".inkos"
    $secretsPath = Join-Path $secretsDir "secrets.json"
    New-Item -ItemType Directory -Force -Path $secretsDir | Out-Null

    $services = [ordered]@{}
    if (Test-Path $secretsPath) {
        try {
            $parsed = [System.IO.File]::ReadAllText($secretsPath) | ConvertFrom-Json
            if ($null -ne $parsed.services) {
                foreach ($property in $parsed.services.PSObject.Properties) {
                    $existingKey = ""
                    if ($null -ne $property.Value -and $null -ne $property.Value.apiKey) {
                        $existingKey = [string]$property.Value.apiKey
                    }
                    $services[$property.Name] = [ordered]@{ apiKey = $existingKey }
                }
            }
        }
        catch {
            $backupPath = "$secretsPath.invalid-$(Get-Date -Format 'yyyyMMdd-HHmmss').bak"
            Copy-Item -Path $secretsPath -Destination $backupPath -Force
            Write-Host "[InkOS Codex] Backed up invalid secrets file: $backupPath"
        }
    }

    $alreadyConfigured = $services.Contains($serviceKey) -and $services[$serviceKey].apiKey
    if (-not $alreadyConfigured) {
        $services[$serviceKey] = [ordered]@{ apiKey = $placeholderKey }
        $payload = [ordered]@{ services = $services } | ConvertTo-Json -Depth 8
        Write-Utf8NoBom $secretsPath $payload
        Write-Host "[InkOS Codex] Installed local bridge credential shim"
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

$loginProbe = Invoke-NativeCapture $codex @("login", "status")
$loginStatus = $loginProbe.Combined
if ($loginProbe.ExitCode -ne 0 -or $loginStatus -notmatch "Logged in using ChatGPT") {
    throw "Codex is not logged in with ChatGPT. Run 'codex login' and choose ChatGPT sign-in first. Current status: $loginStatus"
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
    $baseUrl = "http://127.0.0.1:$BridgePort/v1"

    if (-not (Test-Path $configPath)) {
        Save-BridgeProjectConfig $configPath $baseUrl $Model
        Write-Host "[InkOS Codex] Created preconfigured project: $configPath"
    }
    else {
        $rawConfig = [System.IO.File]::ReadAllText($configPath)
        $cleanConfig = $rawConfig.TrimStart([char]0xFEFF)
        try {
            $null = $cleanConfig | ConvertFrom-Json
            # Always normalize a valid existing config to UTF-8 without BOM.
            # .NET ReadAllText may consume the BOM before PowerShell can detect it.
            Write-Utf8NoBom $configPath $cleanConfig
        }
        catch {
            $backupPath = "$configPath.invalid-$(Get-Date -Format 'yyyyMMdd-HHmmss').bak"
            Copy-Item -Path $configPath -Destination $backupPath -Force
            Save-BridgeProjectConfig $configPath $baseUrl $Model
            Write-Host "[InkOS Codex] Repaired invalid inkos.json (backup: $backupPath)"
        }
    }

    Ensure-BridgeSecret $ProjectRoot

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
