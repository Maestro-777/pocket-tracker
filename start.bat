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
echo Using extended download timeout (120 seconds) and 10 retries.
%PYTHON% -m pip install --disable-pip-version-check --timeout 120 --retries 10 -r requirements.txt
if errorlevel 1 (
  echo.
  echo Dependency installation failed.
  echo Check your internet connection or try again later.
  echo You can also run this command manually:
  echo %PYTHON% -m pip install --timeout 120 --retries 10 -r requirements.txt
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
