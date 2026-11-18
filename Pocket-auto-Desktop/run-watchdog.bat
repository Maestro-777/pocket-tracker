@echo off
setlocal
title Pocket Tracker Desktop - Watchdog
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
    echo Electron dependencies not found. Installing...
    call npm install
    if errorlevel 1 (
        echo npm install failed.
        pause
        exit /b 1
    )
)

echo Starting Pocket Tracker with crash recovery...
echo Close the application normally to stop the watchdog.
call npm run watch

echo.
echo Watchdog stopped.
pause
