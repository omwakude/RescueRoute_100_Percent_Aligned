@echo off
title RescueRoute Command System
echo ==========================================
echo       RESCUEROUTE COMMAND SYSTEM
echo ==========================================
echo.
echo Installing/checking dependencies...
call npm install
echo.
echo Starting server...
echo.
echo Emergency Maker: http://localhost:3000/
echo Admin Dispatch : http://localhost:3000/admin
echo God View       : http://localhost:3000/command
echo.
start http://localhost:3000/
node server.js
pause
