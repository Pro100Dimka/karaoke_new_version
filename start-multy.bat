@echo off
setlocal
chcp 65001 >nul
set "ROOT=%~dp0"
cd /d "%ROOT%"

echo === A^&D Voice: preparing the normal dev profile and one isolated guest ===

set "AD_VOICE_PYTHON=%ROOT%python\.venv\Scripts\python.exe"
rem The normal dev profile and isolated guest reuse immutable, checksum-verified AI models.
set "AD_VOICE_MODELS=%APPDATA%\AD Voice\backend-data\models"
set "AD_VOICE_AUDIO_SERVICE=%ROOT%AudioService\build\Release\AudioService.exe"
rem Python environment, AudioService and the frontend are prepared at the same time.
node "%ROOT%scripts\build-steps.mjs" multi || goto :fail

cd /d "%ROOT%frontend"
set "ELECTRON_RUN_AS_NODE="
node "%ROOT%frontend\scripts\launch-multi.mjs" || goto :fail
echo [app] Two independent instances were launched.
endlocal & exit /b 0

:fail
echo.
echo Multi-instance startup failed. See the messages above.
pause
endlocal & exit /b 1
