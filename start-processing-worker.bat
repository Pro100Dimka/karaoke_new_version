@echo off
setlocal
cd /d "%~dp0python"
set "TEMP=%~dp0.dev-data\ProcessingWorker\temp"
set "TMP=%TEMP%"
if not exist "%TEMP%" mkdir "%TEMP%"
set "PYTHONDONTWRITEBYTECODE=1"
".venv\Scripts\python.exe" -B -m backend.remote_worker %*
exit /b %ERRORLEVEL%
