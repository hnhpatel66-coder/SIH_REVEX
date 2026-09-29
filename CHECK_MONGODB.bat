@echo off
title REVEX - Service Check
echo Checking local MongoDB on 127.0.0.1:27017...
powershell -NoProfile -Command "$c=Test-NetConnection 127.0.0.1 -Port 27017 -WarningAction SilentlyContinue; if($c.TcpTestSucceeded){Write-Host 'MongoDB port 27017 is OPEN.' -ForegroundColor Green}else{Write-Host 'MongoDB port 27017 is NOT reachable.' -ForegroundColor Red; Write-Host 'Start MongoDB service or use MongoDB Atlas in backend\.env.'}"
pause

