@echo off
title New Claude Manager
cd /d "%~dp0"
set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"

if not exist node_modules ( echo First run - installing dependencies... & call npm install )

REM --- Close any already-running instance: kill the node processes listening on ---
REM --- 4040 (server) / 5200 (Vite) so a fresh start never collides on the strict ---
REM --- ports. Only ever targets node.exe - never touches Chrome.                 ---
echo Checking for a running instance...
powershell -NoProfile -Command "$ids = Get-NetTCPConnection -State Listen -LocalPort 4040,5200,4111,5111 -ErrorAction SilentlyContinue | Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -eq 'node' } | Select-Object -ExpandProperty OwningProcess -Unique; if ($ids) { $ids | ForEach-Object { Write-Host ('  Closing existing instance (PID ' + $_ + ')'); Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 2 } else { Write-Host '  None running.' }"

REM --- start the Excalidraw canvas app (Vite 5111 + API 4111) in its own window. ---
REM --- PORT=4111 is forced so it never inherits this machine's global PORT=7777.  ---
echo Starting the Excalidraw canvas (5111 / 4111)...
start "Excalidraw Canvas" /D "%~dp0excalidraw-canvas" cmd /k "set PORT=4111& npm run dev"

REM --- open the ChromeDebug profile at the UI after a short delay, in its own ---
REM --- minimized window. PowerShell avoids cmd nested-quote parsing problems.  ---
start "" /min powershell -NoProfile -Command "Start-Sleep 8; Start-Process '%CHROME%' @('--remote-debugging-port=9222','--user-data-dir=C:/Users/Shubham(Code)/ChromeDebug','http://localhost:5200')"

echo.
echo   New Claude Manager
echo   UI http://localhost:5200   ^|   server 4040   ^|   MCP claude-manager
echo   Canvas http://localhost:5111   ^|   canvas API 4111
echo   Keep this window open while you work. Press Ctrl+C to stop the server.
echo.

call npm run dev

echo.
echo   *** Dev server exited (code %errorlevel%). This window stays open so you can read any error above. ***
pause >nul
