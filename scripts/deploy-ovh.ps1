param(
  [string]$OvhSftpHost = "ftp.cluster129.hosting.ovh.net",
  [string]$OvhSftpUser = "filenyb",
  [string]$OvhRemoteDir = "/home/filenyb/www",
  [string]$LocalSiteDir = "docs/demo",
  [string]$LocalAppFile = "docs/demo/app/index.html",
  [string]$LocalStandaloneFile = "filenymous-app.html",
  [string]$CheckUrl = "https://filenymous.eu/",
  [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$LogPath = Join-Path $env:TEMP ("filenymous-ovh-deploy-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))

function Write-DeployLog {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date -Format s), $Message
  Write-Host $line
  Add-Content -LiteralPath $LogPath -Value $line -Encoding utf8
}

function Assert-Contains {
  param(
    [string]$Text,
    [string]$Marker,
    [string]$Label
  )
  if (-not $Text.Contains($Marker)) {
    throw "$Label missing marker: $Marker"
  }
}

try {
  Set-Content -LiteralPath $LogPath -Value "[started] Filenymous OVH deploy" -Encoding utf8
  Write-DeployLog "Worktree: $(Get-Location)"

  foreach ($path in @("$LocalSiteDir/index.html", "$LocalSiteDir/.htaccess", $LocalAppFile, $LocalStandaloneFile)) {
    if (-not (Test-Path -LiteralPath $path)) {
      throw "Missing local file: $path"
    }
  }

  Write-DeployLog "Checking app/standalone sync"
  $app = (Get-Content -Raw -LiteralPath $LocalAppFile) -replace "`r`n", "`n"
  $standalone = (Get-Content -Raw -LiteralPath $LocalStandaloneFile) -replace "`r`n", "`n"
  if ($app -ne $standalone) {
    throw "$LocalAppFile and $LocalStandaloneFile differ"
  }

  $root = Get-Content -Raw -LiteralPath "$LocalSiteDir/index.html"
  Assert-Contains $root "location.replace('./app/' + location.hash)" "Local root"
  foreach ($marker in @("FILENYMOUS_I18N", "advanced.title", "public-room-create-btn", "rooms.activeTitle", "preferP2PCode: true")) {
    Assert-Contains $app $marker "Local app"
  }

  if (-not $SkipTests) {
    Write-DeployLog "Running targeted tests"
    & npm --prefix tests test -- `
      src/web_mode_standalone.test.ts `
      src/static_room_demo.test.ts `
      src/magic_ux.test.ts `
      src/p2p_direct.test.ts `
      src/p2p_signal_hardening.test.ts `
      src/p2p_signal_server.test.ts `
      src/p2p_signal_relay.test.ts 2>&1 | Tee-Object -FilePath $LogPath -Append
    if ($LASTEXITCODE -ne 0) {
      throw "Tests failed"
    }
  }

  $batchPath = Join-Path $env:TEMP ("filenymous-ovh-{0}.sftp" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
  @"
-mkdir "$OvhRemoteDir/app"
put "$LocalSiteDir/index.html" "$OvhRemoteDir/index.html.tmp"
put "$LocalAppFile" "$OvhRemoteDir/app/index.html.tmp"
put "$LocalSiteDir/.htaccess" "$OvhRemoteDir/.htaccess.tmp"
rename "$OvhRemoteDir/index.html.tmp" "$OvhRemoteDir/index.html"
rename "$OvhRemoteDir/app/index.html.tmp" "$OvhRemoteDir/app/index.html"
rename "$OvhRemoteDir/.htaccess.tmp" "$OvhRemoteDir/.htaccess"
chmod 0644 "$OvhRemoteDir/index.html"
chmod 0644 "$OvhRemoteDir/app/index.html"
chmod 0644 "$OvhRemoteDir/.htaccess"
bye
"@ | Set-Content -LiteralPath $batchPath -Encoding ascii

  Write-DeployLog "SFTP upload starting. Enter the OVH SFTP password in this window if prompted."
  & sftp -4 -oBatchMode=no -b $batchPath "$OvhSftpUser@$OvhSftpHost" 2>&1 | Tee-Object -FilePath $LogPath -Append
  if ($LASTEXITCODE -ne 0) {
    throw "SFTP upload failed with exit code $LASTEXITCODE"
  }

  Write-DeployLog "Verifying public OVH pages"
  $cache = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $liveRoot = (Invoke-WebRequest -Uri "$CheckUrl?check=$cache" -UseBasicParsing -TimeoutSec 30).Content
  $liveApp = (Invoke-WebRequest -Uri "$($CheckUrl.TrimEnd('/'))/app/?check=$cache" -UseBasicParsing -TimeoutSec 30).Content
  Assert-Contains $liveRoot "location.replace('./app/' + location.hash)" "Live root"
  foreach ($marker in @("FILENYMOUS_I18N", "advanced.title", "public-room-create-btn", "rooms.activeTitle", "await window.handleSend(event, { preferP2PCode: true })", "닫기")) {
    Assert-Contains $liveApp $marker "Live app"
  }

  Write-DeployLog "DEPLOY_OK $CheckUrl"
} catch {
  Write-DeployLog "DEPLOY_FAILED $($_.Exception.Message)"
  exit 1
} finally {
  Write-Host ""
  Write-Host "Log: $LogPath"
}
