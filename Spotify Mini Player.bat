@echo off
cd /d "%~dp0"
start "" /b "%~dp0node_modules\electron\dist\electron.exe" .
exit /b
