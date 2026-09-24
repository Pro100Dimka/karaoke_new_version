@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update-room-server.ps1" %*
exit /b %errorlevel%
