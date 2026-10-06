@echo off
rem Signs release binaries with Authenticode when a code-signing certificate is configured.
rem Without one the files stay unsigned (Windows SmartScreen then warns every user) and the
rem release says so instead of failing.
rem
rem   AD_VOICE_SIGN_CERT        a .pfx file, or
rem   AD_VOICE_SIGN_THUMBPRINT  a certificate already in the Windows certificate store
rem   AD_VOICE_SIGN_PASSWORD    the .pfx password (optional)
rem   AD_VOICE_SIGN_TIMESTAMP   RFC 3161 timestamp server (default: DigiCert)
rem
rem Usage: sign-release.bat file [file ...]
setlocal EnableDelayedExpansion
if not defined AD_VOICE_SIGN_CERT if not defined AD_VOICE_SIGN_THUMBPRINT (
  echo [sign] No code-signing certificate configured; left unsigned: %*
  exit /b 0
)
if not defined AD_VOICE_SIGN_TIMESTAMP set "AD_VOICE_SIGN_TIMESTAMP=http://timestamp.digicert.com"

set "SIGNTOOL="
for /f "delims=" %%S in ('where signtool.exe 2^>nul') do if not defined SIGNTOOL set "SIGNTOOL=%%S"
if not defined SIGNTOOL (
  for /f "delims=" %%S in ('dir /b /s /o-n "%ProgramFiles(x86)%\Windows Kits\10\bin\*signtool.exe" 2^>nul ^| findstr /i "\\x64\\signtool.exe"') do if not defined SIGNTOOL set "SIGNTOOL=%%S"
)
if not defined SIGNTOOL (
  echo [sign] signtool.exe was not found; install the Windows SDK signing tools.
  exit /b 1
)

if defined AD_VOICE_SIGN_CERT (
  set "IDENTITY=/f "%AD_VOICE_SIGN_CERT%""
  if defined AD_VOICE_SIGN_PASSWORD set "IDENTITY=!IDENTITY! /p "%AD_VOICE_SIGN_PASSWORD%""
) else (
  set "IDENTITY=/sha1 %AD_VOICE_SIGN_THUMBPRINT%"
)
"%SIGNTOOL%" sign !IDENTITY! /fd sha256 /tr "%AD_VOICE_SIGN_TIMESTAMP%" /td sha256 %*
if errorlevel 1 (
  echo [sign] Signing failed.
  exit /b 1
)
"%SIGNTOOL%" verify /pa %* >nul || exit /b 1
echo [sign] Signed: %*
exit /b 0
