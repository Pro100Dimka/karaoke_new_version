@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title A^&D Voice - Offline Release

set "ROOT=%~dp0"
set "FRONTEND=%ROOT%frontend"
set "PYTHON=%ROOT%python"
set "AUDIO=%ROOT%AudioService"
set "AUDIO_RELEASE_BUILD=%AUDIO%\build-release"
set "RELEASE=%ROOT%release"
set "APP_DIR=%RELEASE%\app\AD Voice"
set "RESOURCES=%APP_DIR%\resources"
set "SETUP=%RELEASE%\AD-Voice-Setup.exe"
set "PYTHON_EXE=%PYTHON%\.venv\Scripts\python.exe"
set "ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
set "RELEASE_ENV=%PYTHON%\.env.example"
set "PRIVATE_RELEASE=0"
if "%~1"=="" goto :release_env_selected
if /i not "%~1"=="--private-env" goto :release_usage
if "%~2"=="" goto :release_usage
if not "%~3"=="" goto :release_usage
for %%E in ("%~2") do set "RELEASE_ENV=%%~fE"
set "PRIVATE_RELEASE=1"
goto :release_env_selected
:release_usage
echo Usage: release.bat [--private-env path-to-env-file]
goto :fail
:release_env_selected
if not exist "%RELEASE_ENV%" (
  echo [error] Configured environment file does not exist.
  goto :fail
)

cd /d "%ROOT%" || goto :fail
if not exist "%PYTHON_EXE%" (
  echo [error] Python environment is missing. Run installer.bat first.
  goto :fail
)
where npm.cmd >nul 2>&1 || goto :missing_tools
where cmake.exe >nul 2>&1 || goto :missing_tools
where ffmpeg.exe >nul 2>&1 || goto :missing_tools
where ffprobe.exe >nul 2>&1 || goto :missing_tools
if not exist "%ISCC%" (
  echo [error] Inno Setup 6 is missing. Install it with: winget install JRSoftware.InnoSetup
  goto :fail
)

echo [1/5] Building AudioService Release x64...
cmake.exe -S "%AUDIO%" -B "%AUDIO_RELEASE_BUILD%" -A x64 -DAUDIOSERVICE_BUILD_TESTS=OFF -DAUDIOSERVICE_BUILD_RELEASE_GATES=OFF
if errorlevel 1 goto :fail
cmake.exe --build "%AUDIO_RELEASE_BUILD%" --config Release --target AudioService --parallel
if errorlevel 1 goto :fail

echo [2/5] Building renderer and Electron...
pushd "%FRONTEND%" || goto :fail
if not exist "node_modules\.bin\tsc.cmd" goto :frontend_dependencies_missing
call npm.cmd run electron:install
if not "%errorlevel%"=="0" goto :frontend_fail
call npm.cmd run build
if errorlevel 1 goto :frontend_fail
call npm.cmd run electron:compile
if errorlevel 1 goto :frontend_fail
popd
goto :frontend_ready

:frontend_dependencies_missing
echo [error] Frontend dependencies are missing. Run installer.bat first.
:frontend_fail
popd
goto :fail

:frontend_ready

echo [3/5] Preparing the application payload...
if exist "%RELEASE%\app" rmdir /s /q "%RELEASE%\app"
mkdir "%APP_DIR%" || goto :fail
robocopy "%FRONTEND%\node_modules\electron\dist" "%APP_DIR%" /E /NFL /NDL /NJH /NJS >nul
if errorlevel 8 goto :fail
if not exist "%APP_DIR%\electron.exe" goto :fail
move /y "%APP_DIR%\electron.exe" "%APP_DIR%\AD Voice.exe" >nul || goto :fail
if exist "%RESOURCES%\default_app.asar" del /q "%RESOURCES%\default_app.asar"
mkdir "%RESOURCES%\app\dist" "%RESOURCES%\app\dist-electron" "%RESOURCES%\app\electron" >nul 2>&1
robocopy "%FRONTEND%\dist" "%RESOURCES%\app\dist" /E /NFL /NDL /NJH /NJS >nul
if errorlevel 8 goto :fail
robocopy "%FRONTEND%\dist-electron" "%RESOURCES%\app\dist-electron" /E /NFL /NDL /NJH /NJS >nul
if errorlevel 8 goto :fail
copy /y "%FRONTEND%\package.json" "%RESOURCES%\app\package.json" >nul || goto :fail
copy /y "%FRONTEND%\electron\splash.html" "%RESOURCES%\app\electron\splash.html" >nul || goto :fail

echo [4/5] Bundling Python, AudioService and FFmpeg...
"%PYTHON_EXE%" -c "import sys; print(sys.base_prefix)" > "%RELEASE%\python-base.txt"
if errorlevel 1 goto :fail
set /p PYTHON_BASE=<"%RELEASE%\python-base.txt"
if not defined PYTHON_BASE goto :fail
robocopy "%PYTHON_BASE%" "%RESOURCES%\python-runtime" /E /NFL /NDL /NJH /NJS /XD "%PYTHON_BASE%\Lib\site-packages" "%PYTHON_BASE%\Doc" "%PYTHON_BASE%\include" "%PYTHON_BASE%\libs" "%PYTHON_BASE%\Tools" "%PYTHON_BASE%\Lib\test" /XF *.pyc *.pyo *.lib *.h *.hpp >nul
if errorlevel 8 goto :fail
rem Package internals named testing/include/lib are runtime dependencies too (NumPy, PyTorch).
robocopy "%PYTHON%\.venv\Lib\site-packages" "%RESOURCES%\python-runtime\Lib\site-packages" /E /NFL /NDL /NJH /NJS /XD __pycache__ /XF *.pyc *.pyo __editable__* >nul
if errorlevel 8 goto :fail
robocopy "%PYTHON%\backend" "%RESOURCES%\python-app\backend" /E /NFL /NDL /NJH /NJS /XF .env /XD __pycache__ >nul
if errorlevel 8 goto :fail
copy /y "%PYTHON%\.env.example" "%RESOURCES%\python-app\.env.example" >nul || goto :fail
if "%PRIVATE_RELEASE%"=="1" echo [private] Bundling explicitly selected service environment. Do not publish this installer.
copy /y "%RELEASE_ENV%" "%RESOURCES%\python-app\.env" >nul || goto :fail
mkdir "%RESOURCES%\audio-service" >nul 2>&1
cmake.exe --install "%AUDIO_RELEASE_BUILD%" --config Release --component AudioServiceRuntime --prefix "%RESOURCES%\audio-service"
if errorlevel 1 goto :fail
mkdir "%RESOURCES%\tools" "%RESOURCES%\theme-icons" >nul 2>&1
for /f "delims=" %%F in ('where ffmpeg.exe') do if not defined FFMPEG_EXE set "FFMPEG_EXE=%%F"
for /f "delims=" %%F in ('where ffprobe.exe') do if not defined FFPROBE_EXE set "FFPROBE_EXE=%%F"
copy /y "%FFMPEG_EXE%" "%RESOURCES%\tools\ffmpeg.exe" >nul || goto :fail
copy /y "%FFPROBE_EXE%" "%RESOURCES%\tools\ffprobe.exe" >nul || goto :fail
robocopy "%FRONTEND%\src\assets\theme-icons" "%RESOURCES%\theme-icons" *.png /NFL /NDL /NJH /NJS >nul
if errorlevel 8 goto :fail
if exist "%FRONTEND%\media" robocopy "%FRONTEND%\media" "%RESOURCES%\media" /E /NFL /NDL /NJH /NJS >nul
ffmpeg.exe -y -loglevel error -i "%FRONTEND%\src\assets\theme-icons\dark.png" -vf scale=256:256 "%RELEASE%\ad-voice.ico"
if errorlevel 1 goto :fail
copy /y "%RELEASE%\ad-voice.ico" "%RESOURCES%\theme-icons\app.ico" >nul || goto :fail

echo [5/5] Building the Windows Setup.exe...
"%RESOURCES%\python-runtime\python.exe" -I "%ROOT%installer\verify_runtime.py" "%RESOURCES%"
if not "%errorlevel%"=="0" goto :fail
for /f "delims=" %%V in ('node.exe -p "require('./frontend/package.json').version"') do set "APP_VERSION=%%V"
if not defined APP_VERSION set "APP_VERSION=1.0.0"
node.exe "%FRONTEND%\scripts\stamp-exe-icon.mjs" "%APP_DIR%\AD Voice.exe" "%RELEASE%\ad-voice.ico" "%APP_VERSION%"
if errorlevel 1 goto :fail
"%ISCC%" "/DAppSource=%APP_DIR%" "/DOutputDir=%RELEASE%" "/DAppVersion=%APP_VERSION%" "/DAppIcon=%RELEASE%\ad-voice.ico" "%ROOT%installer\ad-voice.iss"
if not "%errorlevel%"=="0" goto :fail
if not exist "%SETUP%" goto :fail

echo [cleanup] Keeping only the finished installer...
for /d %%D in ("%RELEASE%\*") do if exist "%%~fD" rmdir /s /q "%%~fD"
for %%F in ("%RELEASE%\*") do if exist "%%~fF" if /i not "%%~nxF"=="AD-Voice-Setup.exe" del /q "%%~fF"

echo.
echo Ready installer: "%SETUP%"
echo Only installer kept in release directory.
endlocal
exit /b 0

:missing_tools
echo [error] npm, CMake, FFmpeg and FFprobe are required. Run installer.bat first.
:fail
echo [error] Release build failed.
endlocal
exit /b 1
