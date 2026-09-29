@echo off
setlocal
chcp 65001 >nul
set "ROOT=%~dp0"
cd /d "%ROOT%"

echo === A^&D Voice: starting ===

rem Python environment, AudioService and the frontend are prepared at the same time.
set "AD_VOICE_PYTHON=%ROOT%python\.venv\Scripts\python.exe"
rem Reuse the checksum-verified models already downloaded by the installed profile.
set "AD_VOICE_MODELS=%APPDATA%\AD Voice\backend-data\models"
set "AD_VOICE_AUDIO_SERVICE=%ROOT%AudioService\build\Release\AudioService.exe"

rem "start.bat dev" runs the renderer on the Vite dev server: saved frontend changes hot-reload, no rebuild.
if /i "%~1"=="dev" (
  node "%ROOT%scripts\build-steps.mjs" dev || goto :fail
  cd /d "%ROOT%frontend"
  set "ELECTRON_RUN_AS_NODE="
  echo [app] dev mode: hot reload is on. Edits under frontend\electron need a restart.
  call npm run dev:app
  set "CODE=%ERRORLEVEL%"
  endlocal & exit /b %CODE%
)
node "%ROOT%scripts\build-steps.mjs" start || goto :fail
cd /d "%ROOT%frontend"

rem Electron must start as an application, not as plain Node.
set "ELECTRON_RUN_AS_NODE="
echo [app] launching (Electron starts and stops Python backend and AudioService itself)...
call npx electron .
set "CODE=%ERRORLEVEL%"

endlocal & exit /b %CODE%

:fail
echo.
echo Startup failed. See the messages above.
pause
endlocal & exit /b 1
