#Requires -RunAsAdministrator
# 自動起動タスクとファイアウォール規則を削除
$ErrorActionPreference = 'SilentlyContinue'
Unregister-ScheduledTask -TaskName 'VoiceMemo' -Confirm:$false
foreach ($port in @(3002, 3443)) { Remove-NetFirewallRule -DisplayName "VoiceMemo (TCP $port)" }
Get-Process node | Where-Object { $_.Path -like '*nodejs*' -and $_.CommandLine -like '*Voicememo*' } | Stop-Process -Force
Write-Host "[OK] VoiceMemo autostart removed"
