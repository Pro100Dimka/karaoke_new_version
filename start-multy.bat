@echo off
setlocal
chcp 65001 >nul
set "ROOT=%~dp0"
cd /d "%ROOT%"

echo === A^&D Voice: preparing the normal dev profile and one isolated guest ===

if not exist "%ROOT%python\.venv\Scripts\python.exe" (
  echo [python] creating virtual environment...
  py -3.12 -m venv "%ROOT%python\.venv" || python -m venv "%ROOT%python\.venv" || goto :fail
  "%ROOT%python\.venv\Scripts\python.exe" -m pip install -e "%ROOT%python" || goto :fail
)
call "%ROOT%ensure-ai-runtime.bat" "%ROOT%python\.venv\Scripts\python.exe" || goto :fail
set "AD_VOICE_PYTHON=%ROOT%python\.venv\Scripts\python.exe"
rem The normal dev profile and isolated guest reuse immutable, checksum-verified AI models.
set "AD_VOICE_MODELS=%APPDATA%\AD Voice\backend-data\models"

echo [audio] building AudioService...
cmake -S "%ROOT%AudioService" -B "%ROOT%AudioService\build" -A x64 || goto :fail
cmake --build "%ROOT%AudioService\build" --config Release || goto :fail
set "AD_VOICE_AUDIO_SERVICE=%ROOT%AudioService\build\Release\AudioService.exe"

cd /d "%ROOT%frontend"
if not exist node_modules (
  echo [frontend] installing dependencies...
  call npm install || goto :fail
)
echo [frontend] building once for both profiles...
call npm run electron:install || goto :fail
call npm run build || goto :fail
call npm run electron:compile || goto :fail

set "ELECTRON_RUN_AS_NODE="
node "%ROOT%frontend\scripts\launch-multi.mjs" || goto :fail
echo [app] Two independent instances were launched.
endlocal & exit /b 0

:fail
echo.
echo Multi-instance startup failed. See the messages above.
pause
endlocal & exit /b 1
