@echo off
title REVEX - Admin Setup

REM Dependencies are installed from the REPOSITORY ROOT only.
REM backend/ intentionally has no node_modules of its own, so the whole app
REM shares a single copy of express/mongoose.

cd /d "%~dp0"

if not exist "node_modules" (
  echo Installing dependencies from the project root...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

node backend\setup-admin.js
pause
