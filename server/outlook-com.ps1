param(
  [ValidateSet('appointment','task')][string]$Kind = 'appointment',
  [string]$Subject = '',
  [string]$Body = '',
  [string]$Start = '',
  [string]$End = '',
  [string]$AllDay = '0'
)
# 従来 Outlook（COM）に予定またはタスクを作成し、ENTRYID=... を出力する。
# 前提: この PC の従来 Outlook にメールプロファイルが設定済みで、サーバーがログオンユーザーとして動いていること。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace('MAPI')
  $null = $ns.GetDefaultFolder(9)   # olFolderCalendar（プロファイル確認）
  if ($Kind -eq 'task') {
    $item = $ol.CreateItem(3)       # olTaskItem
    $item.Subject = $Subject
    $item.Body = $Body
    if ($Start) { $item.DueDate = [datetime]::Parse($Start); $item.ReminderSet = $true; $item.ReminderTime = [datetime]::Parse($Start) }
    $item.Save()
  } else {
    $item = $ol.CreateItem(1)       # olAppointmentItem
    $item.Subject = $Subject
    $item.Body = $Body
    $item.Start = [datetime]::Parse($Start)
    $item.End = [datetime]::Parse($End)
    $item.AllDayEvent = ($AllDay -eq '1')
    $item.ReminderSet = $true
    $item.ReminderMinutesBeforeStart = 15
    $item.Save()
  }
  Write-Output ("ENTRYID=" + $item.EntryID)
  exit 0
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
