@echo off
setlocal

cd /d "%~dp0"

set "LOOPI_UI_SHORTCUT_HELPER=%~dp0scripts\refresh-loopi-ui-shortcut.ps1"
if exist "%LOOPI_UI_SHORTCUT_HELPER%" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%LOOPI_UI_SHORTCUT_HELPER%" -ProjectRoot "%~dp0" >nul 2>nul
)

where npm >nul 2>nul
if errorlevel 1 (
  echo Loopi UI launcher could not find npm on this machine.
  echo Install Node.js 20 or newer, then try again.
  pause
  exit /b 1
)

set "LOOPI_UI_PORT=4311"
set "LOOPI_UI_URL=http://127.0.0.1:%LOOPI_UI_PORT%"
set "LOOPI_BOOTSTRAP_URL=%LOOPI_UI_URL%/api/bootstrap"

echo Starting Loopi UI server on %LOOPI_UI_URL% ...
start "Loopi UI Server" cmd /k "cd /d ""%~dp0"" && npm run ui"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$bootstrapUrl = '%LOOPI_BOOTSTRAP_URL%';" ^
  "$uiUrl = '%LOOPI_UI_URL%';" ^
  "for ($i = 0; $i -lt 30; $i++) {" ^
  "  try {" ^
  "    $response = Invoke-RestMethod -Uri $bootstrapUrl -TimeoutSec 2;" ^
  "    if ($response -and $response.ok -eq $true) {" ^
  "      Start-Process $uiUrl;" ^
  "      exit 0;" ^
  "    }" ^
  "  } catch {}" ^
  "  Start-Sleep -Seconds 1;" ^
  "}" ^
  "Write-Host 'Loopi UI did not come up in time. If the server window shows a port-in-use message, try: npm run ui -- --port 4312';" ^
  "exit 1"

if errorlevel 1 (
  echo.
  echo Loopi UI did not become ready automatically.
  echo If the server window shows that port 4311 is already in use, run:
  echo   npm run ui -- --port 4312
  pause
)

endlocal
