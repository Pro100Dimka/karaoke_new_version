@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title A^&D Voice - Offline Release

set "ROOT=%~dp0"
set "FRONTEND=%ROOT%frontend"
set "PYTHON=%ROOT%python"
set "AUDIO=%ROOT%AudioService"
set "RELEASE=%ROOT%release"
set "APP_DIR=%RELEASE%\app\AD Voice"
set "RESOURCES=%APP_DIR%\resources"
set "MEDIA=%RELEASE%\media"
set "SETUP=%RELEASE%\AD-Voice-Setup.exe"
set "ISO=%RELEASE%\AD-Voice-Setup.iso"
set "PYTHON_EXE=%PYTHON%\.venv\Scripts\python.exe"
set "ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"

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

echo [1/7] Building AudioService Release x64...
cmake.exe -S "%AUDIO%" -B "%AUDIO%\build" -A x64 -DAUDIOSERVICE_BUILD_TESTS=OFF
if errorlevel 1 goto :fail
cmake.exe --build "%AUDIO%\build" --config Release --parallel
if errorlevel 1 goto :fail

echo [2/7] Building renderer and Electron...
pushd "%FRONTEND%" || goto :fail
if not exist "node_modules\.bin\tsc.cmd" goto :frontend_dependencies_missing
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

echo [3/7] Preparing the portable application...
if exist "%RELEASE%\app" rmdir /s /q "%RELEASE%\app"
if exist "%MEDIA%" rmdir /s /q "%MEDIA%"
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

echo [4/7] Bundling Python, AudioService and FFmpeg...
"%PYTHON_EXE%" -c "import sys; print(sys.base_prefix)" > "%RELEASE%\python-base.txt"
if errorlevel 1 goto :fail
set /p PYTHON_BASE=<"%RELEASE%\python-base.txt"
if not defined PYTHON_BASE goto :fail
robocopy "%PYTHON_BASE%" "%RESOURCES%\python-runtime" /E /NFL /NDL /NJH /NJS /XD "%PYTHON_BASE%\Lib\site-packages" >nul
if errorlevel 8 goto :fail
robocopy "%PYTHON%\.venv\Lib\site-packages" "%RESOURCES%\python-runtime\Lib\site-packages" /E /NFL /NDL /NJH /NJS /XD __pycache__ >nul
if errorlevel 8 goto :fail
robocopy "%PYTHON%\backend" "%RESOURCES%\python-app\backend" /E /NFL /NDL /NJH /NJS /XF .env /XD __pycache__ >nul
if errorlevel 8 goto :fail
copy /y "%PYTHON%\.env.example" "%RESOURCES%\python-app\.env.example" >nul || goto :fail
copy /y "%PYTHON%\.env.example" "%RESOURCES%\python-app\.env" >nul || goto :fail
robocopy "%AUDIO%\build\Release" "%RESOURCES%\audio-service" /E /NFL /NDL /NJH /NJS >nul
if errorlevel 8 goto :fail
copy /y "%PYTHON_BASE%\vcruntime*.dll" "%RESOURCES%\audio-service\" >nul 2>&1
copy /y "%PYTHON_BASE%\msvcp*.dll" "%RESOURCES%\audio-service\" >nul 2>&1
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

echo [5/7] Building the Windows Setup.exe...
for /f "delims=" %%V in ('node.exe -p "require('./frontend/package.json').version"') do set "APP_VERSION=%%V"
if not defined APP_VERSION set "APP_VERSION=1.0.0"
"%ISCC%" "/DAppSource=%APP_DIR%" "/DOutputDir=%RELEASE%" "/DAppVersion=%APP_VERSION%" "/DAppIcon=%RELEASE%\ad-voice.ico" "%ROOT%installer\ad-voice.iss"
if errorlevel 1 goto :fail
if not exist "%SETUP%" goto :fail

echo [6/7] Preparing installation media...
mkdir "%MEDIA%" || goto :fail
copy /y "%SETUP%" "%MEDIA%\AD-Voice-Setup.exe" >nul || goto :fail
copy /y "%ROOT%installer\README.txt" "%MEDIA%\README.txt" >nul || goto :fail

echo [7/7] Creating AD-Voice-Setup.iso...
"%PYTHON_EXE%" -m pip install --disable-pip-version-check pycdlib==1.14.0
if errorlevel 1 goto :fail
if exist "%ISO%" del /q "%ISO%"
"%PYTHON_EXE%" "%ROOT%scripts\create_release_iso.py" "%MEDIA%" "%ISO%"
if errorlevel 1 goto :fail

echo.
echo Ready installer: "%SETUP%"
echo Ready ISO:       "%ISO%"
endlocal
exit /b 0

:missing_tools
echo [error] npm, CMake, FFmpeg and FFprobe are required. Run installer.bat first.
:fail
echo [error] Release build failed.
endlocal
exit /b 1
