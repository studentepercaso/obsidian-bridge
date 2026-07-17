@echo off
setlocal
title Installazione Obsidian Bridge
set "OB_SCRIPT=%~dp0plugins\obsidian-bridge\installer\Install-ObsidianBridge.ps1"
if not exist "%OB_SCRIPT%" set "OB_SCRIPT=%~dp0installer\Install-ObsidianBridge.ps1"
if not exist "%OB_SCRIPT%" (
  echo Installatore non trovato. Estrai l intero ZIP prima di eseguire questo file.
  pause
  exit /b 2
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -STA -File "%OB_SCRIPT%" %*
set "OB_EXIT=%ERRORLEVEL%"
if not "%OB_EXIT%"=="0" (
  echo.
  echo Installazione non completata. Codice: %OB_EXIT%
  pause
)
exit /b %OB_EXIT%
