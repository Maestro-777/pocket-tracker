@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  set PYTHON=py -3
) else (
  set PYTHON=python
)

echo [1/2] Installing Python dependencies...
%PYTHON% -m pip install -r requirements.txt
if errorlevel 1 (
  echo.
  echo Dependency installation failed. Check that Python 3.10+ is installed.
  pause
  exit /b 1
)

echo.
echo [2/2] Starting Pocket Tracker...
echo Open http://127.0.0.1:8000 in your browser.
echo Keep this window open while using the chart.
echo.
%PYTHON% bridge.py
pause
