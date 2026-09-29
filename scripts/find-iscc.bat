@echo off
rem Sets ISCC to Inno Setup 6's compiler wherever it was installed: WinGet puts it under the user's
rem profile without administrator rights and under Program Files with them. The uninstall entry
rem Windows keeps for it records the real folder; the usual folders and PATH are the fallback.
rem Called from installer.bat and release.bat; leaves ISCC empty when Inno Setup is absent.
set "ISCC="
set "INNO_DIR="
for %%K in ("HKCU\Software" "HKLM\Software" "HKLM\Software\WOW6432Node") do (
    if not defined INNO_DIR (
        for /f "tokens=2,*" %%A in ('reg query "%%~K\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1" /v InstallLocation 2^>nul ^| find "InstallLocation"') do set "INNO_DIR=%%B"
    )
)
rem The recorded folder ends with a backslash.
if defined INNO_DIR if "%INNO_DIR:~-1%"=="\" set "INNO_DIR=%INNO_DIR:~0,-1%"
if defined INNO_DIR if exist "%INNO_DIR%\ISCC.exe" set "ISCC=%INNO_DIR%\ISCC.exe"
for %%D in ("%ProgramFiles(x86)%\Inno Setup 6" "%ProgramFiles%\Inno Setup 6" "%LOCALAPPDATA%\Programs\Inno Setup 6") do (
    if not defined ISCC if exist "%%~D\ISCC.exe" set "ISCC=%%~D\ISCC.exe"
)
if not defined ISCC for /f "delims=" %%F in ('where ISCC.exe 2^>nul') do if not defined ISCC set "ISCC=%%F"
set "INNO_DIR="
exit /b 0
