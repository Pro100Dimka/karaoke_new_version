@echo off
set "TRACE_REPO=C:\Users\pro10\Documents\karaoke_new_version"
set "AD_VOICE_PYTHON=%TRACE_REPO%\python\.venv\Scripts\python.exe"
set "AD_VOICE_MODELS=%APPDATA%\AD Voice\backend-data\models"
set "AD_VOICE_AUDIO_SERVICE=%TRACE_REPO%\AudioService\build\Release\AudioService.exe"
set "AD_VOICE_ROOM_PACKET_TRACE="
set "AD_VOICE_ROOM_E2E=1"
set "AD_VOICE_WASAPI_DIAGNOSTIC_EXCLUSIVE_INPUT_PERIOD_FRAMES=480"
set "ELECTRON_RUN_AS_NODE="
cd /d "%TRACE_REPO%\frontend"
node scripts\start-electron.mjs --remote-debugging-port=9351 > "%USERPROFILE%\adv-packet-trace.log" 2>&1
