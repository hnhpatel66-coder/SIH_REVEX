@echo off
title REVEX - Working Prototype
cd /d "%~dp0"

if not exist "backend\node_modules" (
  echo Installing backend dependencies...
  cd backend
  npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
  cd ..
)

echo.
echo Preparing MongoDB demo data and admin...
cd backend
node seed.js
if errorlevel 1 (
  echo.
  echo MongoDB seed failed. Check backend\.env and MongoDB/Atlas network.
  pause
  exit /b 1
)

echo.
echo Starting REVEX...
echo Website: http://localhost:5000
echo Health:  http://localhost:5000/api/health
echo Admin:  admin@vroomy.com
echo.
npm start
pause

