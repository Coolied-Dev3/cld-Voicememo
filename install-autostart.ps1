#Requires -RunAsAdministrator
# ============================================================
# cld-Voice Memo  Windows 自動起動セットアップ（管理者で 1 回実行）
#   - ファイアウォール TCP 3002 / 3443 を開放
#   - PC 起動時（ログイン不要・SYSTEM 権限）に run-prod.cmd を起動するタスクを登録  ← 既定
#     ※ OUTLOOK_MODE=com（この PC の従来 Outlook に COM 登録）を使う場合だけ、
#       Outlook と同じユーザーセッションが必要なので -AtLogon を付けて「ログオン時」に登録する
# 使い方（このフォルダで、管理者 PowerShell）:
#   powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1            # PC 起動時（推奨）
#   powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1 -AtLogon   # ログオン時（COM 用）
# 再実行すると既存のタスクを置き換えます。
# ============================================================
param([switch]$AtLogon)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$cmd  = Join-Path $root 'run-prod.cmd'
$taskName = 'VoiceMemo'
$ports = @(3002, 3443)

Write-Host "Project : $root"
Write-Host "Command : $cmd"

# 1) Firewall
foreach ($port in $ports) {
  $name = "VoiceMemo (TCP $port)"
  if (-not (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Any | Out-Null
    Write-Host "[OK] Firewall rule added (allow TCP $port)"
  } else {
    Write-Host "[..] Firewall rule already exists (TCP $port)"
  }
}

# 2) 既存タスクを停止・削除（起動中のサーバーも止める）
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*Voicememo*server*index.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

# 3) タスク登録
$action   = New-ScheduledTaskAction -Execute $cmd -WorkingDirectory $root
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
if ($AtLogon) {
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $trigger.Delay = 'PT20S'
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $desc = "user=$user / at logon / 20s delay"
} else {
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $trigger.Delay = 'PT30S'
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $desc = "SYSTEM / at startup (no logon needed) / 30s delay"
}
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "[OK] Task '$taskName' registered ($desc)"

# 4) 今すぐ起動して確認
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 6
try {
  $r = Invoke-WebRequest -UseBasicParsing "http://localhost:3002/api/health" -TimeoutSec 10
  Write-Host "[OK] Server responded (HTTP $($r.StatusCode)) $($r.Content)"
} catch {
  Write-Host "[NG] Could not reach server. Check logs\server.log : $($_.Exception.Message)"
}

$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.*' } | Select-Object -First 1 -ExpandProperty IPAddress)
Write-Host ""
Write-Host "=== Setup done ==="
Write-Host "This PC    : http://localhost:3002"
if ($ip) { Write-Host "LAN        : http://${ip}:3002" }
Write-Host "It will start automatically after reboot."
