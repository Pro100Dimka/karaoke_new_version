@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title A^&D Voice - Release ISO

set "ROOT=%~dp0"
set "FRONTEND=%ROOT%frontend"
set "PYTHON=%ROOT%python"
set "AUDIO=%ROOT%AudioService"
set "STAGE=%ROOT%release\stage\AD-Voice"
set "ISO=%ROOT%release\AD-Voice-Setup.iso"
set "PYTHON_EXE=%PYTHON%\.venv\Scripts\python.exe"

cd /d "%ROOT%" || goto :fail
if not exist "%PYTHON_EXE%" (
  echo [error] Python environment is missing. Run installer.bat first.
  goto :fail
)
where npm.cmd >nul 2>&1 || goto :missing_tools
where cmake.exe >nul 2>&1 || goto :missing_tools

echo [1/5] Building AudioService Release x64...
cmake.exe -S "%AUDIO%" -B "%AUDIO%\build" -A x64 -DAUDIOSERVICE_BUILD_TESTS=OFF
if errorlevel 1 goto :fail
cmake.exe --build "%AUDIO%\build" --config Release --parallel
if errorlevel 1 goto :fail

echo [2/5] Building renderer and Electron...
pushd "%FRONTEND%" || goto :fail
call npm.cmd ci
if errorlevel 1 (popd & goto :fail)
call npm.cmd run build
if errorlevel 1 (popd & goto :fail)
call npm.cmd run electron:compile
if errorlevel 1 (popd & goto :fail)
popd

echo [3/5] Preparing clean installation media...
if exist "%ROOT%release\stage" rmdir /s /q "%ROOT%release\stage"
mkdir "%STAGE%" || goto :fail
copy /y "%ROOT%installer.bat" "%STAGE%\installer.bat" >nul || goto :fail
copy /y "%ROOT%start.bat" "%STAGE%\start.bat" >nul || goto :fail
robocopy "%ROOT%docs" "%STAGE%\docs" /E /NFL /NDL /NJH /NJS /XF .env /XD .git __pycache__ >nul
if errorlevel 8 goto :fail
robocopy "%AUDIO%" "%STAGE%\AudioService" /E /NFL /NDL /NJH /NJS /XF .env /XD build .git >nul
if errorlevel 8 goto :fail
mkdir "%STAGE%\AudioService\build\Release" >nul 2>&1
copy /y "%AUDIO%\build\Release\AudioService.exe" "%STAGE%\AudioService\build\Release\AudioService.exe" >nul || goto :fail
robocopy "%FRONTEND%" "%STAGE%\frontend" /E /NFL /NDL /NJH /NJS /XF .env /XD node_modules .git test-results playwright-report >nul
if errorlevel 8 goto :fail
robocopy "%PYTHON%" "%STAGE%\python" /E /NFL /NDL /NJH /NJS /XF .env /XD .venv data .git __pycache__ .mypy_cache .pytest_cache .ruff_cache >nul
if errorlevel 8 goto :fail

echo [4/5] Installing the ISO writer in the build environment...
"%PYTHON_EXE%" -m pip install --disable-pip-version-check pycdlib==1.14.0
if errorlevel 1 goto :fail

echo [5/5] Creating AD-Voice-Setup.iso...
if exist "%ISO%" del /q "%ISO%"
"%PYTHON_EXE%" "%ROOT%scripts\create_release_iso.py" "%STAGE%" "%ISO%"
if errorlevel 1 goto :fail

echo.
echo Release created: "%ISO%"
endlocal
exit /b 0

:missing_tools
echo [error] npm and CMake are required. Run installer.bat first.
:fail
echo [error] Release build failed.
endlocal
exit /b 1
