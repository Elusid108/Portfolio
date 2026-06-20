@echo off
title Portfolio CMS
cd /d "%~dp0"
echo Stopping any existing CMS server...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
echo Starting Portfolio CMS...
echo.
start http://localhost:3000
node server.js
pause
