$ErrorActionPreference = "Stop"

function Get-CommandOrNull([string]$Name) {
    return Get-Command $Name -ErrorAction SilentlyContinue
}

function Resolve-WindowsCommand([string]$BaseName) {
    if ($env:OS -eq "Windows_NT") {
        $cmd = Get-CommandOrNull "$BaseName.cmd"
        if ($cmd) { return $cmd.Source }
        $exe = Get-CommandOrNull "$BaseName.exe"
        if ($exe) { return $exe.Source }
    }
    $plain = Get-CommandOrNull $BaseName
    if ($plain) { return $plain.Source }
    return $null
}

function Invoke-NativeCapture([string]$FilePath, [string[]]$Arguments) {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = (& $FilePath @Arguments 2>&1 | Out-String).Trim()
        $exitCode = $LASTEXITCODE
        return [PSCustomObject]@{
            Output = $output
            ExitCode = $exitCode
        }
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
}

Write-Host "[InkOS Codex Bridge] Checking local prerequisites..."

$nodeBin = Resolve-WindowsCommand "node"
if (-not $nodeBin) {
    throw "Node.js is required. Install Node.js 20 or newer, reopen PowerShell, and run this script again."
}

$nodeVersionText = (& $nodeBin -p "process.versions.node").Trim()
$nodeMajor = [int]($nodeVersionText.Split('.')[0])
if ($nodeMajor -lt 20) {
    throw "Node.js 20+ is required. Current version: $nodeVersionText"
}
Write-Host "  Node.js: $nodeVersionText"

$codexBin = Resolve-WindowsCommand "codex"
if (-not $codexBin) {
    Write-Host "  Codex CLI not found. Installing the official OpenAI Codex CLI..."
    $npmBin = Resolve-WindowsCommand "npm"
    if ($npmBin) {
        & $npmBin install -g @openai/codex
        if ($LASTEXITCODE -ne 0) {
            throw "npm failed to install @openai/codex."
        }
    }
    else {
        Invoke-RestMethod "https://chatgpt.com/codex/install.ps1" | Invoke-Expression
    }
    $codexBin = Resolve-WindowsCommand "codex"
}

if (-not $codexBin) {
    throw "Codex was installed but is not visible in this PowerShell session. Close PowerShell, open it again, and rerun this script."
}

$codexVersionResult = Invoke-NativeCapture $codexBin @("--version")
if ($codexVersionResult.ExitCode -ne 0) {
    throw "Codex CLI could not start. Output: $($codexVersionResult.Output)"
}
Write-Host "  Codex: $($codexVersionResult.Output)"

$loginResult = Invoke-NativeCapture $codexBin @("login", "status")
$loginStatus = $loginResult.Output
Write-Host "  Login: $loginStatus"

if ($loginStatus -notmatch "Logged in using ChatGPT") {
    Write-Host ""
    Write-Host "ChatGPT login is required. A browser sign-in may open now."
    & $codexBin login
    if ($LASTEXITCODE -ne 0) {
        throw "Codex ChatGPT login did not complete successfully."
    }

    $loginResult = Invoke-NativeCapture $codexBin @("login", "status")
    $loginStatus = $loginResult.Output
    if ($loginStatus -notmatch "Logged in using ChatGPT") {
        throw "Codex is still not logged in using ChatGPT. Current status: $loginStatus"
    }
}

Write-Host ""
Write-Host "Running the real ChatGPT-plan bridge check..."
& $nodeBin scripts/codex-openai-bridge.mjs --check
if ($LASTEXITCODE -ne 0) {
    throw "The Codex bridge check failed. Copy the error shown above back to ChatGPT."
}

Write-Host ""
Write-Host "SUCCESS: InkOS -> local bridge -> Codex CLI -> ChatGPT plan is working."
Write-Host "Next bridge command: node scripts/codex-openai-bridge.mjs"
Write-Host "Bridge base URL for InkOS: http://127.0.0.1:43127/v1"
