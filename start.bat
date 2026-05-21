@echo off
title Löwen Dart Dashboard
:loop
echo [%date% %time%] Server startet...
node "%~dp0server.js"
if %errorlevel% == 0 (
  echo [%date% %time%] Server-Neustart angefordert...
  goto loop
)
echo [%date% %time%] Server beendet (Code %errorlevel%). Kein automatischer Neustart.
pause
