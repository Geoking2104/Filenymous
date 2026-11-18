# download-binaries.ps1
# Telecharge holochain (release officielle) dans src-tauri/bins/ (Windows x64).
# Holochain 0.6 : lair-keystore tourne in-process, plus de sidecar lair.

$ErrorActionPreference = "Stop"

$HolochainVersion = "0.6.1"
$Platform         = "x86_64-pc-windows-msvc"
$Dest             = "src-tauri\bins"

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$DestPath = Join-Path $Dest "holochain-v$HolochainVersion-$Platform.exe"
if (Test-Path $DestPath) {
    Write-Host "  deja present : $DestPath"
} else {
    $Url = "https://github.com/holochain/holochain/releases/download/holochain-$HolochainVersion/holochain-$Platform.exe"
    Write-Host "Telechargement : $Url"
    & curl.exe -L -f --progress-bar -o $DestPath $Url
    if ($LASTEXITCODE -ne 0) {
        Remove-Item -Force $DestPath -ErrorAction SilentlyContinue
        throw "Echec telechargement holochain (code $LASTEXITCODE)"
    }
}
Write-Host "Binaire pret : $DestPath"
