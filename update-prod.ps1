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
$task = Get-ScheduledTask -TaskName 'VoiceMemo' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*Voicememo*server*index.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 1
if ($task) { Start-ScheduledTask -TaskName 'VoiceMemo'; Write-Host "[OK] task restarted" }
else { Start-Process -FilePath (Join-Path $PSScriptRoot 'run-prod.cmd') -WindowStyle Hidden; Write-Host "[OK] server started (no autostart task)" }
Start-Sleep -Seconds 3
try { (Invoke-WebRequest -UseBasicParsing 'http://localhost:3002/api/health' -TimeoutSec 10).Content } catch { Write-Host "[NG] $($_.Exception.Message)" }
