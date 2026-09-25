@echo off
setlocal
chcp 65001 >nul
set "ROOT=%~dp0"
cd /d "%ROOT%"

echo === A^&D Voice: starting ===

rem --- Python backend environment ---
if not exist "%ROOT%python\.venv\Scripts\python.exe" (
  echo [python] creating virtual environment...
  py -3.12 -m venv "%ROOT%python\.venv" || python -m venv "%ROOT%python\.venv" || goto :fail
  "%ROOT%python\.venv\Scripts\python.exe" -m pip install -e "%ROOT%python" || goto :fail
)
"%ROOT%python\.venv\Scripts\python.exe" -c "import yt_dlp; import backend" >nul 2>&1
if errorlevel 1 (
  echo [python] repairing missing runtime dependencies...
  "%ROOT%python\.venv\Scripts\python.exe" -m pip install --editable "%ROOT%python" || goto :fail
  "%ROOT%python\.venv\Scripts\python.exe" -c "import yt_dlp; import backend" || goto :fail
)
call "%ROOT%ensure-ai-runtime.bat" "%ROOT%python\.venv\Scripts\python.exe" || goto :fail
set "AD_VOICE_PYTHON=%ROOT%python\.venv\Scripts\python.exe"
rem Reuse the checksum-verified models already downloaded by the installed profile.
set "AD_VOICE_MODELS=%APPDATA%\AD Voice\backend-data\models"

rem --- AudioService: built incrementally; Electron owns only its profile-specific process ---
echo [audio] building AudioService...
cmake -S "%ROOT%AudioService" -B "%ROOT%AudioService\build" -A x64 || goto :fail
cmake --build "%ROOT%AudioService\build" --config Release || goto :fail
set "AD_VOICE_AUDIO_SERVICE=%ROOT%AudioService\build\Release\AudioService.exe"

rem --- Frontend + Electron ---
cd /d "%ROOT%frontend"
if not exist node_modules (
  echo [frontend] installing dependencies...
  call npm install || goto :fail
)
rem "start.bat dev" runs the renderer on the Vite dev server: saved frontend changes hot-reload, no rebuild.
if /i "%~1"=="dev" (
  set "ELECTRON_RUN_AS_NODE="
  echo [app] dev mode: hot reload is on. Edits under frontend\electron need a restart.
  call npm run dev:app
  set "CODE=%ERRORLEVEL%"
  endlocal & exit /b %CODE%
)
echo [frontend] building...
call npm run build || goto :fail
call npm run electron:compile || goto :fail

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
