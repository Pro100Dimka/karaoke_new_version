@echo off
setlocal EnableExtensions

set "PYTHON_EXE=%~1"
if not exist "%PYTHON_EXE%" (
    echo [error] Python runtime does not exist: "%PYTHON_EXE%"
    exit /b 1
)

rem PyPI installs the CPU build on Windows. If an NVIDIA adapter is present, repair that
rem environment with the official CUDA wheels so the exact same AI models run on the GPU.
where nvidia-smi.exe >nul 2>&1
if errorlevel 1 exit /b 0

"%PYTHON_EXE%" -c "import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)" >nul 2>&1
if not errorlevel 1 exit /b 0

echo [python] NVIDIA GPU detected; installing the CUDA AI runtime...
"%PYTHON_EXE%" -m pip install --upgrade torch==2.11.0+cu130 torchaudio==2.11.0+cu130 --index-url https://download.pytorch.org/whl/cu130
if errorlevel 1 exit /b 1
"%PYTHON_EXE%" -c "import torch, torchaudio; assert torch.cuda.is_available(); print('[python] CUDA:', torch.cuda.get_device_name(0), '| torch', torch.__version__, '| torchaudio', torchaudio.__version__)"
exit /b %ERRORLEVEL%
