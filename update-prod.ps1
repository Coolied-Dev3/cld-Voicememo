# ソース更新後の本番反映: フロントを再ビルドしてサーバーを再起動
#   powershell -ExecutionPolicy Bypass -File .\update-prod.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
Write-Host "== npm install"
npm install --no-audit --no-fund | Out-Null
Push-Location server; npm install --no-audit --no-fund | Out-Null; Pop-Location
Write-Host "== build"
npm run build
Write-Host "== restart"
# 画面（dist）だけの変更なら再起動は不要（Express がその場で配信する）。server/ を変えた場合は再起動が必要。
# 自動起動タスクは SYSTEM 権限で動いているため、再起動は管理者 PowerShell で実行すること。
$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $elevated) {
  Write-Host "[..] 管理者権限ではないためサーバーの再起動はスキップしました（画面の変更は反映済み）。server/ を変更した場合は管理者 PowerShell でこのスクリプトを実行してください。"
} else {
  $task = Get-ScheduledTask -TaskName 'VoiceMemo' -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*Voicememo*server*index.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Seconds 1
  if ($task) { Start-ScheduledTask -TaskName 'VoiceMemo'; Write-Host "[OK] task restarted" }
  else { Start-Process -FilePath (Join-Path $PSScriptRoot 'run-prod.cmd') -WindowStyle Hidden; Write-Host "[OK] server started (no autostart task)" }
}
Start-Sleep -Seconds 3
try { (Invoke-WebRequest -UseBasicParsing 'http://localhost:3002/api/health' -TimeoutSec 10).Content } catch { Write-Host "[NG] $($_.Exception.Message)" }
