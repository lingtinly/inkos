$ErrorActionPreference = "Stop"

function Get-CommandOrNull([string]$Name) {
    return Get-Command $Name -ErrorAction SilentlyContinue
}

Write-Host "[InkOS Codex Bridge] Checking local prerequisites..."

if (-not (Get-CommandOrNull "node")) {
    throw "Node.js is required. Install Node.js 20 or newer, reopen PowerShell, and run this script again."
}

$nodeVersionText = (& node -p "process.versions.node").Trim()
$nodeMajor = [int]($nodeVersionText.Split('.')[0])
if ($nodeMajor -lt 20) {
    throw "Node.js 20+ is required. Current version: $nodeVersionText"
}
Write-Host "  Node.js: $nodeVersionText"

if (-not (Get-CommandOrNull "codex")) {
    Write-Host "  Codex CLI not found. Installing the official OpenAI Codex CLI..."
    if (Get-CommandOrNull "npm") {
        & npm install -g @openai/codex
        if ($LASTEXITCODE -ne 0) {
            throw "npm failed to install @openai/codex."
        }
    }
    else {
        Invoke-RestMethod "https://chatgpt.com/codex/install.ps1" | Invoke-Expression
    }
}

if (-not (Get-CommandOrNull "codex")) {
    throw "Codex was installed but is not visible in this PowerShell session. Close PowerShell, open it again, and rerun this script."
}

$codexVersion = (& codex --version 2>&1 | Out-String).Trim()
Write-Host "  Codex: $codexVersion"

$loginStatus = (& codex login status 2>&1 | Out-String).Trim()
Write-Host "  Login: $loginStatus"

if ($loginStatus -notmatch "Logged in using ChatGPT") {
    Write-Host ""
    Write-Host "ChatGPT login is required. A browser sign-in may open now."
    & codex login
    if ($LASTEXITCODE -ne 0) {
        throw "Codex ChatGPT login did not complete successfully."
    }

    $loginStatus = (& codex login status 2>&1 | Out-String).Trim()
    if ($loginStatus -notmatch "Logged in using ChatGPT") {
        throw "Codex is still not logged in using ChatGPT. Current status: $loginStatus"
    }
}

Write-Host ""
Write-Host "Running the real ChatGPT-plan bridge check..."
& node scripts/codex-openai-bridge.mjs --check
if ($LASTEXITCODE -ne 0) {
    throw "The Codex bridge check failed. Copy the error shown above back to ChatGPT."
}

Write-Host ""
Write-Host "SUCCESS: InkOS -> local bridge -> Codex CLI -> ChatGPT plan is working."
Write-Host "Next bridge command: node scripts/codex-openai-bridge.mjs"
Write-Host "Bridge base URL for InkOS: http://127.0.0.1:43127/v1"
