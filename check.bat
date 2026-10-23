@echo off
setlocal
set "ROOT=%~dp0"
cd /d "%ROOT%"
rem Per-process scratch/cache only; no Windows-wide settings or user profiles change.
if exist E:\ (
  if not exist E:\CodexTemp\ADVoice-checks mkdir E:\CodexTemp\ADVoice-checks
  set "TEMP=E:\CodexTemp\ADVoice-checks"
  set "TMP=E:\CodexTemp\ADVoice-checks"
  set "TMPDIR=E:\CodexTemp\ADVoice-checks"
  set "npm_config_cache=E:\CodexTemp\ADVoice-checks\npm-cache"
  set "PYTHONPYCACHEPREFIX=E:\CodexTemp\ADVoice-checks\pycache"
  set "MYPY_CACHE_DIR=E:\CodexTemp\ADVoice-checks\mypy-cache"
  set "RUFF_CACHE_DIR=E:\CodexTemp\ADVoice-checks\ruff-cache"
)
node "%ROOT%scripts\build-steps.mjs" check %*
exit /b %ERRORLEVEL%
