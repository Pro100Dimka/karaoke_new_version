@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
set "ROOT=%~dp0"
set "SCENARIO=%~1"
set "INPUT=%~2"
if "%SCENARIO%"=="" set "SCENARIO=normal"
if "%INPUT%"=="" (
  echo Usage: start-multi-simulated.bat ^<normal^|wifi^|bad-wifi^|asymmetric^|spikes^> ^<input.wav^> [output.wav]
  exit /b 2
)
if "%~3"=="" (
  for /f "tokens=1-4 delims=:." %%a in ("%time%") do set "STAMP=%%a%%b%%c%%d"
  set "OUTPUT=%ROOT%artifacts\room-e2e\simulated-%SCENARIO%-!STAMP!.wav"
) else (
  set "OUTPUT=%~3"
)
if not exist "%ROOT%AudioService\build\Release\AudioService.exe" (
  echo AudioService Release binary not found. Run start-multy.bat first.
  exit /b 3
)
if not exist "%ROOT%artifacts\room-e2e" mkdir "%ROOT%artifacts\room-e2e"
echo Running room network impairment scenario: %SCENARIO%
"%ROOT%AudioService\build\Release\AudioService.exe" --network-test --scenario "%SCENARIO%" --input "%INPUT%" --output "%OUTPUT%"
if errorlevel 1 exit /b %errorlevel%
echo Evidence WAV: %OUTPUT%
endlocal & exit /b 0
