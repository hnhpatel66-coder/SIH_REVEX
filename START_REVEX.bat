@echo off
title REVEX - Local Server
cd /d "%~dp0"

if not exist "node_modules" (
  echo Installing application dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo Starting REVEX...
echo Website: http://localhost:5001
echo Health:  http://localhost:5001/api/health
echo.
call npm start
pause
