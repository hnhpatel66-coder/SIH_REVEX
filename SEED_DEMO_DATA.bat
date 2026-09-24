@echo off
title REVEX - Demo Data
cd /d "%~dp0backend"
if not exist "node_modules" npm install
node seed.js
pause

