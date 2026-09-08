@echo off
rem 本番起動ラッパー（自動起動タスクから呼ばれる）
rem フロント本番ビルド(dist)を含め、Express が :3002（HTTPS 有効時は :3443 も）で配信する
cd /d "%~dp0"
if not exist "%~dp0logs" mkdir "%~dp0logs"
"C:\Program Files\nodejs\node.exe" "%~dp0server\index.js" >> "%~dp0logs\server.log" 2>&1
