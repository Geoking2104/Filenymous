<#
.SYNOPSIS
    Build the Filenymous React UI (ui/) and deploy it to filenymous.eu/app/ on OVH.

.DESCRIPTION
    Implements the production path for the React build that filenymous.eu/app/
    actually serves:
      1. cd ui ; npm ci
      2. npm run build  (runs: tsc --noEmit && vite build --base=/app/)
         -> emits ui/dist/ with asset URLs rooted at /app/ so they resolve at
            https://filenymous.eu/app/assets/...
      3. SFTP: back up the current remote /app/ to /app.bak-<ts>/, then upload
         ui/dist/* into /home/filenyb/www/app/.

    Credentials are NOT stored in the repo. The OVH SFTP password is read
    interactively (or from $env:OVH_SFTP_PASS).

    Host : ftp.cluster129.hosting.ovh.net  (SFTP, port 22)
    User : filenyb
    Web root on server: /home/filenyb/www   ->  app lives at www/app/

.NOTES
    Requires Node 18+ on PATH, and either WinSCP (winscp.com) or PowerShell 7+
    (built-in SFTP). On plain Windows PowerShell 5.1 the SFTP fallback is
    unavailable, so install WinSCP in that case.
#>

$ErrorActionPreference = 'Stop'

$Host_     = 'ftp.cluster129.hosting.ovh.net'
$Port      = 22
$User      = 'filenyb'
$RemoteApp = '/home/filenyb/www/app'
$RemoteBak = '/home/filenyb/www/app.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '')
$UiDir    = Join-Path $RepoRoot 'ui'
$DistDir  = Join-Path $UiDir 'dist'

if (-not (Test-Path $UiDir)) { Write-Error "ui/ not found at $UiDir" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Error "Node.js not found on PATH." }

# --- password ----------------------------------------------------------------
if ($env:OVH_SFTP_PASS) {
    $Password = $env:OVH_SFTP_PASS
} else {
    $sec = Read-Host -Prompt "OVH SFTP password for user '$User'" -AsSecureString
    $BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    $Password = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
}

# --- 1. install + build ------------------------------------------------------
Write-Host "== Building ui/ (npm ci && vite build --base=/app/) ==" -ForegroundColor Cyan
Push-Location $UiDir
try {
    & npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
    & npm run build -- --base=/app/
    if ($LASTEXITCODE -ne 0) { throw "vite build failed (tsc --noEmit also runs and must pass)." }
} finally {
    Pop-Location
}

if (-not (Test-Path (Join-Path $DistDir 'index.html'))) {
    Write-Error "Build produced no ui/dist/index.html — aborting upload."
}

# --- 2. upload via SFTP ------------------------------------------------------
Write-Host "== Backing up remote $RemoteApp -> $RemoteBak ==" -ForegroundColor Cyan
Write-Host "== Uploading $DistDir -> $RemoteApp ==" -ForegroundColor Cyan

$winScp = Get-Command winscp.com -ErrorAction SilentlyContinue
if ($winScp) {
    # WinSCP: mkdir backup, copy current app into it, then push new dist.
    $script = @"
option batch on
option confirm off
open sftp://$User`:$Password@$Host_`:$Port
mkdir $RemoteBak
mv $RemoteApp/assets $RemoteBak/assets
mv $RemoteApp/index.html $RemoteBak/index.html
put -r $DistDir/* $RemoteApp/
close
exit
"@
    $scriptFile = Join-Path $env:TEMP 'filenymous-ui-deploy.txt'
    Set-Content -Path $scriptFile -Value $script -Encoding ascii
    & $winScp.Source $scriptFile
    $ok = $LASTEXITCODE -eq 0
} else {
    if ($PSVersionTable.PSVersion.Major -lt 7) {
        Write-Error "No winscp.com found and PowerShell 7+ SFTP is unavailable. Install WinSCP or run from PowerShell 7+."
    }
    $ses = New-SFTPSession -ComputerName $Host_ -Port $Port -Credential ($cred = New-Object System.Management.Automation.PSCredential($User, (ConvertTo-SecureString $Password -AsPlainText -Force)))
    try {
        New-SFTPItem -SessionId $ses.SessionId -Path $RemoteBak -ItemType Directory -Force
        # move existing assets + index.html into backup
        try { Move-SFTPItem -SessionId $ses.SessionId -Path "$RemoteApp/assets" -Destination "$RemoteBak/assets" -Force } catch { Write-Host "  (no existing assets to back up)" }
        try { Move-SFTPItem -SessionId $ses.SessionId -Path "$RemoteApp/index.html" -Destination "$RemoteBak/index.html" -Force } catch { Write-Host "  (no existing index.html to back up)" }
        # upload new dist contents
        Get-ChildItem $DistDir | ForEach-Object {
            Set-SFTPItem -SessionId $ses.SessionId -LocalFile $_.FullName -RemotePath $RemoteApp -Force
        }
        $ok = $true
    } finally {
        Remove-SFTPSession -SessionId $ses.SessionId | Out-Null
    }
}

if (-not $ok) {
    Write-Error "Upload failed. The previous /app/ was moved to $RemoteBak, so the site may be partially updated — restore from the backup if needed."
}

Write-Host "`n== Verify ==" -ForegroundColor Cyan
Write-Host "Open https://filenymous.eu/app/ — it should now serve the React UI with the" -ForegroundColor Yellow
Write-Host "browser-only self-contained encrypted-link transfer path (commit 152ac6b)." -ForegroundColor Yellow
Write-Host "Done." -ForegroundColor Green
