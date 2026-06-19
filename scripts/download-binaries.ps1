# download-binaries.ps1
# Telecharge holochain + lair-keystore dans src-tauri/bins/ (Windows x64)

$ErrorActionPreference = "Stop"

$HolochainVersion = "0.3.2"
$LairVersion      = "0.4.5"
$Platform         = "x86_64-pc-windows-msvc"
$Dest             = "src-tauri\bins"

Write-Host "Plateforme : $Platform"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

function Get-Binary {
    param([string]$RepoPath, [string]$Filename)
    $DestPath = Join-Path $Dest $Filename
    if (Test-Path $DestPath) {
        Write-Host "  deja present : $DestPath"
        return
    }
    $Url = "https://github.com/matthme/holochain-binaries/releases/download/$RepoPath/$Filename"
    Write-Host "Telechargement : $Url"
    & curl.exe -L -f --progress-bar -o $DestPath $Url
    if ($LASTEXITCODE -ne 0) {
        Remove-Item -Force $DestPath -ErrorAction SilentlyContinue
        throw "Echec $Filename (code $LASTEXITCODE)"
    }
    Write-Host "  OK $DestPath"
}

Get-Binary "holochain-binaries-$HolochainVersion" "holochain-v$HolochainVersion-$Platform.exe"
Get-Binary "lair-binaries-$LairVersion"           "lair-keystore-v$LairVersion-$Platform.exe"

Write-Host ""
Write-Host "Binaires prets dans $Dest\"
Get-ChildItem $Dest | Format-Table Name, Length
