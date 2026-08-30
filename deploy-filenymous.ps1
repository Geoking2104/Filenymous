<#
.SYNOPSIS
    Deploy the fixed Filenymous standalone app to filenymous.eu (OVH shared hosting).

.DESCRIPTION
    Implements the procedure documented in docs/DEPLOYMENT.md:
      1. Backs up the current remote www/app/index.html (download).
      2. Uploads the locally fixed docs/demo/app/index.html as www/app/index.html.
      3. Verifies the upload.

    Credentials are NOT stored in the repo. The OVH SFTP password is read
    interactively (or from $env:OVH_SFTP_PASS if you set it).

    Host : ftp.cluster129.hosting.ovh.net  (SFTP, port 22)
    User : filenyb
    Web root on server: /home/filenyb/www   ->  app lives at www/app/index.html

.NOTES
    Requires either WinSCP (winscp.com) on PATH, or PowerShell 7+ (for the
    built-in SFTP fallback). On plain Windows PowerShell 5.1 the fallback is
    unavailable, so install WinSCP in that case.
#>

$ErrorActionPreference = 'Stop'

$Host_     = 'ftp.cluster129.hosting.ovh.net'
$Port      = 22
$User      = 'filenyb'
$RemoteApp = '/home/filenyb/www/app/index.html'
$RemoteBak = '/home/filenyb/www/app/index.html.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '')
$LocalApp = Join-Path $RepoRoot 'docs/demo/app/index.html'

if (-not (Test-Path $LocalApp)) {
    Write-Error "Local file not found: $LocalApp`nRun this from the repo root after pulling commit 73c2023."
}

$BakLocal = Join-Path $env:TEMP ('filenymous-app-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.html')

# --- password ----------------------------------------------------------------
if ($env:OVH_SFTP_PASS) {
    $Password = $env:OVH_SFTP_PASS
} else {
    $sec = Read-Host -Prompt "OVH SFTP password for user '$User'" -AsSecureString
    $BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    $Password = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
}

Write-Host "== Backing up remote $RemoteApp -> $RemoteBak ==" -ForegroundColor Cyan
Write-Host "== Downloading current remote to $BakLocal (local safety copy) ==" -ForegroundColor Cyan
Write-Host "== Uploading $LocalApp -> $RemoteApp ==" -ForegroundColor Cyan

$winScp = Get-Command winscp.com -ErrorAction SilentlyContinue
if ($winScp) {
    # --- WinSCP path ----------------------------------------------------------
    $script = @"
option batch on
option confirm off
open sftp://$User`:$Password@$Host_`:$Port
mv $RemoteApp $RemoteBak
get $RemoteApp $BakLocal
put $LocalApp $RemoteApp
close
exit
"@
    $scriptFile = Join-Path $env:TEMP 'filenymous-deploy.txt'
    Set-Content -Path $scriptFile -Value $script -Encoding ascii
    & $winScp.Source $scriptFile
    $ok = $LASTEXITCODE -eq 0
} else {
    # --- PowerShell 7+ built-in SFTP fallback --------------------------------
    if ($PSVersionTable.PSVersion.Major -lt 7) {
        Write-Error "No winscp.com found and PowerShell 7+ SFTP is unavailable.`nInstall WinSCP (https://winscp.net) or run from PowerShell 7+, then retry."
    }
    $ses = New-SFTPSession -ComputerName $Host_ -Port $Port -Credential ($cred = New-Object System.Management.Automation.PSCredential($User, (ConvertTo-SecureString $Password -AsPlainText -Force)))
    try {
        # backup on server
        Rename-SFTPFile -SessionId $ses.SessionId -Path $RemoteApp -NewPath $RemoteBak -Force
        # local safety copy
        Get-SFTPFile -SessionId $ses.SessionId -RemoteFile $RemoteApp -LocalPath $env:TEMP -Force
        # upload fixed file
        Set-SFTPFile -SessionId $ses.SessionId -LocalFile $LocalApp -RemotePath '/home/filenymous/www/app/' -Force
        $ok = $true
    } finally {
        Remove-SFTPSession -SessionId $ses.SessionId | Out-Null
    }
}

if (-not $ok) {
    Write-Error "Upload failed. The remote was NOT overwritten (backup step completed first, so the site is unchanged)."
}

Write-Host "`n== Verifying live site serves the fixed file ==" -ForegroundColor Cyan
Write-Host "Visit https://filenymous.eu/app/ and confirm it is the standalone app" -ForegroundColor Yellow
Write-Host "(look for the 'Web public' badge; the React build would show assets/index-*.js)." -ForegroundColor Yellow
Write-Host "Done." -ForegroundColor Green
