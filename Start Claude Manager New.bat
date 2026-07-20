@echo off
title New Claude Manager
cd /d "%~dp0"

REM The launcher runs the whole app (server 4040, frontend 5200, canvas 4111/5111)
REM inside a Windows job object tied to THIS window. Closing this window — or
REM Ctrl+C — kills the entire app, so no hidden node/vite instance survives.
REM Chrome is launched outside the job and is never closed.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher.ps1"
