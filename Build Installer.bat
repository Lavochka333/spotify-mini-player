@echo off
setlocal
cd /d "%~dp0"
title Spotify Mini Player - Build Installer
where node >nul 2>&1
if errorlevel 1 goto missing_node
where npm.cmd >nul 2>&1
if errorlevel 1 goto missing_node
echo Installing build dependencies...
call npm.cmd install --include=dev
if errorlevel 1 goto failed
if not exist "node_modules\electron\dist\electron.exe" (
  node "node_modules\electron\install.js"
  if errorlevel 1 goto failed
)
echo Building Windows installer...
call npm.cmd run build:installer
if errorlevel 1 goto failed
echo.
echo Done! Send the Setup EXE from the dist folder to your friend.
start "" explorer.exe "%~dp0dist"
pause
exit /b 0
:missing_node
echo Install Node.js 20 or newer from https://nodejs.org and try again.
pause
exit /b 1
:failed
echo.
echo Build failed. See the error above.
pause
exit /b 1
