<#
Build the world page and (re)start the server.

  .\run.ps1                       build web, stop anything on :8000, start the server
  .\run.ps1 -Dev                  also start the hot-reload page on :5173
  .\run.ps1 -NoBuild              skip the web build
  .\run.ps1 --source synth        anything else goes to `uv run deck`
                                  (e.g. --no-read, --record recordings/run1)
#>
param(
    [switch]$Dev,
    [switch]$NoBuild,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$DeckArgs = @()
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Invoke-Native {
    param([string]$Exe, [string[]]$ArgList)
    & $Exe @ArgList
    if ($LASTEXITCODE -ne 0) { throw "$Exe $($ArgList -join ' ') failed (exit $LASTEXITCODE)" }
}

# Node is installed but not always on PATH.
if (-not (Get-Command npm -ErrorAction SilentlyContinue) -and (Test-Path 'C:\Program Files\nodejs')) {
    $env:PATH = "C:\Program Files\nodejs;$env:PATH"
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm not found: install Node.js' }
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw 'uv not found: install uv' }

# Stop whatever is listening on a port, so a re-run reloads cleanly.
function Clear-Port([int]$Port) {
    $owners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $owners) {
        if ($procId -gt 0) {
            & taskkill.exe /PID $procId /T /F *> $null
            Write-Host "Stopped old process on :$Port"
        }
    }
}

if (-not (Test-Path 'web\node_modules')) {
    Write-Host 'Installing web dependencies...'
    Invoke-Native npm @('--prefix', 'web', 'install')
}
Invoke-Native uv @('sync')

if (-not $NoBuild) {
    Write-Host 'Building world page...'
    Invoke-Native npm @('--prefix', 'web', 'run', 'build')
}

Clear-Port 8000

$vite = $null
try {
    if ($Dev) {
        Clear-Port 5173
        $vite = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm --prefix web run dev' -NoNewWindow -PassThru
        Write-Host 'Hot-reload page: http://localhost:5173'
    }
    Write-Host 'World page: http://localhost:8000  (press G for the setup guide)'
    & uv run deck @DeckArgs
}
finally {
    if ($vite -and -not $vite.HasExited) { & taskkill.exe /PID $vite.Id /T /F *> $null }
}
