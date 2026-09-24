@echo off
title REVEX - Admin Setup
cd /d "%~dp0backend"
if not exist "node_modules" (
  echo Installing dependencies...
  npm install
)
node setup-admin.js
pause

