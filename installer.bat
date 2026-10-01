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

rem Tools installed by WinGet (now or in an earlier run) are not always on this process's PATH yet.
set "PATH=%ProgramFiles%\nodejs;%ProgramFiles%\CMake\bin;%ProgramFiles%\Git\cmd;%LOCALAPPDATA%\Microsoft\WindowsApps;%LOCALAPPDATA%\Microsoft\WinGet\Links;%LOCALAPPDATA%\Programs\Python\Python313;%LOCALAPPDATA%\Programs\Python\Python313\Scripts;%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts;%PATH%"

echo [1/5] Checking system prerequisites...
set "NEED_INSTALL="
set "NEED_ADMIN="
for %%T in (python node cmake git ffmpeg inno cpp) do (
    call :has_%%T
    if errorlevel 1 (
        echo     missing: %%T
        set "NEED_INSTALL=1"
        if /i "%%T"=="cpp" set "NEED_ADMIN=1"
    )
)
if not defined NEED_INSTALL (
    echo     Everything is already installed; nothing to download.
    goto :prerequisites_ready
)

rem Only the Visual C++ workload requires the whole setup process to be elevated.
if defined NEED_ADMIN (
    fltmc >nul 2>&1
    if errorlevel 1 (
        echo [admin] Requesting administrator rights for Visual C++ Build Tools...
        powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '%~1' -WorkingDirectory '%ROOT%' -Verb RunAs"
        if errorlevel 1 (
            echo [error] Administrator rights were not granted.
            goto :fail
        )
        exit /b 0
    )
)
call :find_winget
if errorlevel 1 (
    echo [error] WinGet is not installed.
    echo Install "App Installer" from Microsoft Store, then run this file again.
    goto :fail
)

echo.
echo [2/5] Installing only the missing prerequisites...
"%WINGET_EXE%" source update --disable-interactivity
if errorlevel 1 goto :fail
call :ensure_tool python "Python.Python.3.12" "Python 3.12" || goto :fail
call :ensure_tool node "OpenJS.NodeJS.LTS" "Node.js LTS" || goto :fail
call :ensure_tool cmake "Kitware.CMake" "CMake" || goto :fail
call :ensure_tool git "Git.Git" "Git" || goto :fail
call :ensure_tool ffmpeg "Gyan.FFmpeg" "FFmpeg and FFprobe" || goto :fail
call :ensure_tool inno "JRSoftware.InnoSetup" "Inno Setup 6" || goto :fail
call :ensure_cpp_toolchain || goto :fail

:prerequisites_ready

echo.
echo [3/5] Verifying required tools...
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
call :require_command git.exe "Git"
if errorlevel 1 goto :fail
call :require_command ffmpeg.exe "FFmpeg"
if errorlevel 1 goto :fail
call :require_command ffprobe.exe "FFprobe"
if errorlevel 1 goto :fail
call "%ROOT%scripts\find-iscc.bat"
if not defined ISCC (
    echo [error] Inno Setup compiler was not found.
    goto :fail
)

echo     Python: "%PYTHON_EXE%"
"%PYTHON_EXE%" --version
node.exe --version
cmake.exe --version | findstr /b /c:"cmake version"
ffmpeg.exe -version 2>&1 | findstr /b /c:"ffmpeg version"

echo.
echo [4/5] Creating the Python virtual environment...
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
echo [5/5] Python packages, frontend dependencies, AudioService and the frontend (in parallel)...
set "AD_VOICE_MODELS=%APPDATA%\AD Voice\backend-data\models"
node.exe "%ROOT%scripts\build-steps.mjs" install
if errorlevel 1 goto :fail
if not exist "%AUDIO_DIR%\build\Release\AudioService.exe" (
    echo [error] AudioService.exe was not produced.
    goto :fail
)

echo.
echo ============================================================
echo   Installation completed successfully.
echo   Start the application with start.bat
echo ============================================================
echo.
if "%NO_PAUSE%"=="0" pause
endlocal
exit /b 0

rem --- Is a prerequisite already present? Each returns 0 when it is. ---------------------------
:has_python
call :find_python >nul 2>&1 || exit /b 1
"%PYTHON_EXE%" -c "import sys; raise SystemExit(0 if (3, 12) <= sys.version_info < (3, 14) else 1)" >nul 2>&1
exit /b %ERRORLEVEL%

:has_node
where node.exe >nul 2>&1 || exit /b 1
node.exe -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
exit /b %ERRORLEVEL%

:has_cmake
where cmake.exe >nul 2>&1
exit /b %ERRORLEVEL%

:has_git
where git.exe >nul 2>&1
exit /b %ERRORLEVEL%

:has_ffmpeg
where ffmpeg.exe >nul 2>&1 || exit /b 1
where ffprobe.exe >nul 2>&1
exit /b %ERRORLEVEL%

:has_inno
call "%ROOT%scripts\find-iscc.bat"
if defined ISCC exit /b 0
exit /b 1

:has_cpp
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" exit /b 1
set "VS_FOUND="
for /f "usebackq delims=" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VS_FOUND=%%I"
if defined VS_FOUND exit /b 0
exit /b 1

rem Installs a WinGet package only when its check says the tool is missing.
:ensure_tool
call :has_%~1
if not errorlevel 1 (
    echo     %~3: already installed.
    exit /b 0
)
call :winget_install "%~2" "%~3"
if errorlevel 1 exit /b 1
call :has_%~1
if not errorlevel 1 exit /b 0
if /i "%~1"=="python" (
    echo     Python 3.12 is registered at a missing path; installing supported Python 3.13 instead...
    call :winget_install "Python.Python.3.13" "Python 3.13"
    if errorlevel 1 exit /b 1
    call :has_python
    if not errorlevel 1 exit /b 0
)
echo     %~3 is registered but its executable is unavailable; reinstalling it cleanly...
"%WINGET_EXE%" uninstall --id "%~2" --exact --silent --disable-interactivity
if errorlevel 1 (
    echo [error] Failed to remove the broken %~3 installation ^(%~2^).
    exit /b 1
)
call :winget_install "%~2" "%~3"
if errorlevel 1 exit /b 1
call :has_%~1
if errorlevel 1 (
    echo [error] %~3 is still unavailable after a clean reinstall.
    exit /b 1
)
exit /b 0

:winget_install
echo     %~2...
"%WINGET_EXE%" install --id "%~1" --exact --force --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
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
    "%WINGET_EXE%" install --id "Microsoft.VisualStudio.2022.BuildTools" --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity --override "--wait --quiet --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
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
if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not defined PYTHON_EXE if exist "%ProgramFiles%\Python313\python.exe" set "PYTHON_EXE=%ProgramFiles%\Python313\python.exe"
if not defined PYTHON_EXE if exist "%LOCALAPPDATA%\Python\pythoncore-3.13-64\python.exe" set "PYTHON_EXE=%LOCALAPPDATA%\Python\pythoncore-3.13-64\python.exe"
if not defined PYTHON_EXE if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PYTHON_EXE if exist "%ProgramFiles%\Python312\python.exe" set "PYTHON_EXE=%ProgramFiles%\Python312\python.exe"
if not defined PYTHON_EXE if exist "%LOCALAPPDATA%\Python\pythoncore-3.12-64\python.exe" set "PYTHON_EXE=%LOCALAPPDATA%\Python\pythoncore-3.12-64\python.exe"
if not defined PYTHON_EXE (
    for /f "delims=" %%I in ('py.exe -3.13 -c "import sys; print(sys.executable)" 2^>nul') do if exist "%%I" set "PYTHON_EXE=%%I"
)
if not defined PYTHON_EXE (
    for /f "delims=" %%I in ('py.exe -3.12 -c "import sys; print(sys.executable)" 2^>nul') do if exist "%%I" set "PYTHON_EXE=%%I"
)
if not defined PYTHON_EXE (
    echo [error] Python 3.12 or 3.13 was installed but could not be located.
    exit /b 1
)
if not exist "%PYTHON_EXE%" (
    echo [error] Python executable does not exist: "%PYTHON_EXE%"
    exit /b 1
)
exit /b 0

:find_winget
set "WINGET_EXE=%LOCALAPPDATA%\Microsoft\WindowsApps\winget.exe"
if exist "%WINGET_EXE%" exit /b 0
set "WINGET_EXE="
for /f "delims=" %%I in ('where winget.exe 2^>nul') do if not defined WINGET_EXE set "WINGET_EXE=%%I"
if defined WINGET_EXE exit /b 0
exit /b 1

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
