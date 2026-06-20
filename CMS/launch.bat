@echo off
title Portfolio CMS
cd /d "%~dp0"
echo Starting Portfolio CMS...
echo.
start http://localhost:3000
node server.js
pause
