@echo off
setlocal
cd /d "%~dp0python"
if not exist E:\ (
  echo The processing worker requires drive E:.
  exit /b 1
)
set "TEMP=E:\ADVoiceData\ProcessingWorker\temp"
set "TMP=%TEMP%"
if not exist "%TEMP%" mkdir "%TEMP%"
set "PYTHONDONTWRITEBYTECODE=1"
".venv\Scripts\python.exe" -B -m backend.remote_worker %*
exit /b %ERRORLEVEL%
