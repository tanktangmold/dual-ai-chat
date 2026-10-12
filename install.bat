@echo off
rem Dual AI Chat one-click installer: runs scripts\install.ps1 (no admin rights needed)
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
echo.
pause
