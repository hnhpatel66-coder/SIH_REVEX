@echo off
setlocal
title REVEX - Seed Local Demo Data
cd /d "%~dp0"

if not exist "node_modules\express\package.json" (
  echo Installing dependencies from the project root...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

call npm run seed
pause
