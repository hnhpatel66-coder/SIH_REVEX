@echo off
setlocal
title REVEX 1.5 - Local Server
cd /d "%~dp0"

echo ============================================
echo        REVEX 1.5 - LOCAL HOST SETUP
echo ============================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js is not installed.
  echo Install Node.js 18+ and run this file again.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm is not installed or not on PATH.
  pause
  exit /b 1
)

echo Node:
node -v
echo npm:
npm -v
echo.

if not exist "node_modules\express\package.json" (
  echo Installing REVEX dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo ERROR: npm install failed.
    echo Check your internet connection and run: npm install
    pause
    exit /b 1
  )
)

echo.
echo Checking MongoDB on 127.0.0.1:27017...
powershell -NoProfile -Command "$c=Test-NetConnection 127.0.0.1 -Port 27017 -WarningAction SilentlyContinue; if($c.TcpTestSucceeded){exit 0}else{exit 1}"
if errorlevel 1 (
  echo.
  echo ERROR: Local MongoDB is not reachable on port 27017.
  echo Start the MongoDB service, then run START_REVEX.bat again.
  echo.
  echo If MongoDB is not installed, install MongoDB Community Server first.
  pause
  exit /b 1
)

echo.
echo Creating demo/admin data if it does not already exist...
call npm run seed
if errorlevel 1 (
  echo.
  echo WARNING: Demo seed failed. The server will still be started.
)

echo.
echo ============================================
echo REVEX is starting...
echo Website: http://localhost:5001
echo Health:  http://localhost:5001/api/health
echo Admin:  admin@vroomy.local / Admin@12345
echo Owner:  demo.owner@vroomy.local / Demo@12345
echo ============================================
echo.

call npm start
pause
