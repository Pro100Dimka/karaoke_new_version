@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title A^&D Voice - Installer

set "ROOT=%~dp0"
set "PYTHON_DIR=%ROOT%python"
set "FRONTEND_DIR=%ROOT%frontend"
set "AUDIO_DIR=%ROOT%AudioService"
set "VENV_DIR=%PYTHON_DIR%\.venv"
set "NO_PAUSE=0"
if /i "%~1"=="--no-pause" set "NO_PAUSE=1"

cd /d "%ROOT%" || goto :fail

echo ============================================================
echo   A^&D Voice - complete Windows setup
echo ============================================================
echo.

rem Installing the Visual C++ workload requires administrator rights.
fltmc >nul 2>&1
if errorlevel 1 (
    echo [admin] Requesting administrator rights...
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '%~1' -WorkingDirectory '%ROOT%' -Verb RunAs"
    if errorlevel 1 (
        echo [error] Administrator rights were not granted.
        goto :fail
    )
    exit /b 0
)

where winget.exe >nul 2>&1
if errorlevel 1 (
    echo [error] WinGet is not installed.
    echo Install "App Installer" from Microsoft Store, then run this file again.
    goto :fail
)

echo [1/8] Updating WinGet sources...
winget source update --disable-interactivity
if errorlevel 1 goto :fail

echo.
echo [2/8] Installing system prerequisites...
call :winget_install "Python.Python.3.12" "Python 3.12"
if errorlevel 1 goto :fail
call :winget_install "OpenJS.NodeJS.LTS" "Node.js LTS"
if errorlevel 1 goto :fail
call :winget_install "Kitware.CMake" "CMake"
if errorlevel 1 goto :fail
call :winget_install "Gyan.FFmpeg" "FFmpeg and FFprobe"
if errorlevel 1 goto :fail
call :ensure_cpp_toolchain
if errorlevel 1 goto :fail

rem WinGet changes are not added to the current process automatically.
set "PATH=%ProgramFiles%\nodejs;%ProgramFiles%\CMake\bin;%LOCALAPPDATA%\Microsoft\WinGet\Links;%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts;%PATH%"

echo.
echo [3/8] Verifying required tools...
call :find_python
if errorlevel 1 goto :fail
"%PYTHON_EXE%" -c "import sys; raise SystemExit(0 if (3, 12) <= sys.version_info < (3, 14) else 1)"
if errorlevel 1 (
    echo [error] Python 3.12 or 3.13 is required.
    goto :fail
)
call :require_command node.exe "Node.js"
if errorlevel 1 goto :fail
for /f "delims=" %%V in ('node.exe -p "Number(process.versions.node.split('.')[0])"') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR (
    echo [error] Could not read the Node.js version.
    goto :fail
)
if %NODE_MAJOR% LSS 20 (
    echo [error] Node.js 20 or newer is required. Found major version %NODE_MAJOR%.
    goto :fail
)
call :require_command npm.cmd "npm"
if errorlevel 1 goto :fail
call :require_command cmake.exe "CMake"
if errorlevel 1 goto :fail
call :require_command ffmpeg.exe "FFmpeg"
if errorlevel 1 goto :fail
call :require_command ffprobe.exe "FFprobe"
if errorlevel 1 goto :fail

echo     Python: "%PYTHON_EXE%"
"%PYTHON_EXE%" --version
node.exe --version
cmake.exe --version | findstr /b /c:"cmake version"
ffmpeg.exe -version 2>&1 | findstr /b /c:"ffmpeg version"

echo.
echo [4/8] Creating the Python virtual environment...
if exist "%VENV_DIR%\Scripts\python.exe" (
    "%VENV_DIR%\Scripts\python.exe" -c "import sys; raise SystemExit(0 if (3, 12) <= sys.version_info < (3, 14) else 1)"
    if errorlevel 1 (
        echo     Existing virtual environment uses an incompatible Python; recreating it.
        rmdir /s /q "%VENV_DIR%"
        if exist "%VENV_DIR%" goto :fail
    )
)
if not exist "%VENV_DIR%\Scripts\python.exe" (
    "%PYTHON_EXE%" -m venv "%VENV_DIR%"
    if errorlevel 1 goto :fail
)

echo.
echo [5/8] Installing all Python packages...
"%VENV_DIR%\Scripts\python.exe" -m pip install --upgrade pip setuptools wheel
if errorlevel 1 goto :fail
"%VENV_DIR%\Scripts\python.exe" -m pip install --requirement "%PYTHON_DIR%\requirements.lock"
if errorlevel 1 goto :fail
"%VENV_DIR%\Scripts\python.exe" -m pip install --editable "%PYTHON_DIR%" --no-deps
if errorlevel 1 goto :fail
"%VENV_DIR%\Scripts\python.exe" -c "import fastapi, sqlalchemy, uvicorn, torch, demucs, whisper, torchcrepe; import backend"
if errorlevel 1 goto :fail

echo.
echo [6/8] Installing exact frontend dependencies...
pushd "%FRONTEND_DIR%" || goto :fail
call npm.cmd ci
if errorlevel 1 (
    popd
    goto :fail
)
popd

echo.
echo [7/8] Building AudioService (Release x64)...
cmake.exe -S "%AUDIO_DIR%" -B "%AUDIO_DIR%\build" -A x64 -DAUDIOSERVICE_BUILD_TESTS=OFF
if errorlevel 1 goto :fail
cmake.exe --build "%AUDIO_DIR%\build" --config Release --parallel
if errorlevel 1 goto :fail
if not exist "%AUDIO_DIR%\build\Release\AudioService.exe" (
    echo [error] AudioService.exe was not produced.
    goto :fail
)

echo.
echo [8/8] Building the frontend and Electron main process...
pushd "%FRONTEND_DIR%" || goto :fail
call npm.cmd run build
if errorlevel 1 (
    popd
    goto :fail
)
call npm.cmd run electron:compile
if errorlevel 1 (
    popd
    goto :fail
)
popd

echo.
echo ============================================================
echo   Installation completed successfully.
echo   Start the application with start.bat
echo ============================================================
echo.
if "%NO_PAUSE%"=="0" pause
endlocal
exit /b 0

:winget_install
echo     %~2...
winget install --id "%~1" --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
if errorlevel 1 (
    echo [error] Failed to install %~2 ^(%~1^).
    exit /b 1
)
exit /b 0

:ensure_cpp_toolchain
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "VS_INSTALL="
set "VS_ANY_INSTALL="
if exist "%VSWHERE%" (
    for /f "usebackq delims=" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VS_INSTALL=%%I"
    for /f "usebackq delims=" %%I in (`"%VSWHERE%" -latest -products * -property installationPath`) do set "VS_ANY_INSTALL=%%I"
)
if defined VS_INSTALL (
    echo     Visual Studio C++ Build Tools: already installed.
    exit /b 0
)

echo     Visual Studio 2022 Build Tools with Desktop C++ workload...
if defined VS_ANY_INSTALL (
    set "VS_SETUP=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\setup.exe"
    if not exist "%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\setup.exe" (
        echo [error] Visual Studio Installer setup.exe was not found.
        exit /b 1
    )
    "%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\setup.exe" modify --installPath "%VS_ANY_INSTALL%" --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --quiet --norestart
    if errorlevel 1 exit /b 1
) else (
    winget install --id "Microsoft.VisualStudio.2022.BuildTools" --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity --override "--wait --quiet --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    if errorlevel 1 exit /b 1
)

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "VS_INSTALL="
if exist "%VSWHERE%" (
    for /f "usebackq delims=" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VS_INSTALL=%%I"
)
if not defined VS_INSTALL (
    echo [error] The Visual C++ x64 build tools were not detected after installation.
    exit /b 1
)
exit /b 0

:find_python
set "PYTHON_EXE="
if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PYTHON_EXE if exist "%ProgramFiles%\Python312\python.exe" set "PYTHON_EXE=%ProgramFiles%\Python312\python.exe"
if not defined PYTHON_EXE (
    for /f "delims=" %%I in ('py.exe -3.12 -c "import sys; print(sys.executable)" 2^>nul') do set "PYTHON_EXE=%%I"
)
if not defined PYTHON_EXE (
    echo [error] Python 3.12 was installed but could not be located.
    exit /b 1
)
if not exist "%PYTHON_EXE%" (
    echo [error] Python executable does not exist: "%PYTHON_EXE%"
    exit /b 1
)
exit /b 0

:require_command
where "%~1" >nul 2>&1
if errorlevel 1 (
    echo [error] %~2 was not found in PATH after installation.
    exit /b 1
)
exit /b 0

:fail
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" set "EXIT_CODE=1"
echo.
echo ============================================================
echo   Installation failed. Review the error above.
echo ============================================================
echo.
if "%NO_PAUSE%"=="0" pause
endlocal & exit /b %EXIT_CODE%
