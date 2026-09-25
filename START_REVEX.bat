<<<<<<< HEAD
@echo off
=======
﻿@echo off
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
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
<<<<<<< HEAD
echo Website: http://localhost:5001
echo Health:  http://localhost:5001/api/health
=======
echo Website: http://localhost:5000
echo Health:  http://localhost:5000/api/health
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
echo.
call npm start
pause
