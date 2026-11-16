@echo off
setlocal
set "ROOT=%~dp0"
cd /d "%ROOT%"
rem Per-process scratch/cache only; no Windows-wide settings or user profiles change.
set "CHECK_TEMP=%ROOT%.dev-data\temp\checks"
if not exist "%CHECK_TEMP%" mkdir "%CHECK_TEMP%"
set "TEMP=%CHECK_TEMP%"
set "TMP=%CHECK_TEMP%"
set "TMPDIR=%CHECK_TEMP%"
set "npm_config_cache=%~d0\Caches\npm"
set "PIP_CACHE_DIR=%~d0\Caches\pip"
set "PYTHONPYCACHEPREFIX=%~d0\Caches\python"
set "MYPY_CACHE_DIR=%~d0\Caches\mypy"
set "RUFF_CACHE_DIR=%~d0\Caches\ruff"
node "%ROOT%scripts\build-steps.mjs" check %*
exit /b %ERRORLEVEL%
