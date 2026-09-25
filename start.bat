@echo off
setlocal
cd /d "%~dp0"

echo.
echo   An Inch of Red
echo   ------------------------------------------------------------
echo   A local server will start, then a browser window will open.
echo   Press Ctrl+C in this window to stop the server.
echo.

rem ---------------------------------------------------------------- python
rem Windows ships a fake python.exe in WindowsApps: running it opens the
rem Microsoft Store instead of a shell. So "it is on PATH" proves nothing --
rem every candidate has to really execute something before we trust it.
set "PY="
py -3 -c "import sys" >nul 2>nul
if not errorlevel 1 set "PY=py -3"

if not defined PY (
  python -c "import sys" >nul 2>nul
  if not errorlevel 1 set "PY=python"
)

if not defined PY (
  python3 -c "import sys" >nul 2>nul
  if not errorlevel 1 set "PY=python3"
)

if not defined PY (
  echo   [X] No working Python 3 was found on this machine.
  echo.
  echo       Install Python 3 from https://www.python.org/downloads/
  echo       and tick "Add python.exe to PATH" during setup,
  echo       then double-click this file again.
  echo.
  echo       Note: the "python" shortcut Windows offers in the Store does
  echo       NOT count - it only opens the Store.
  echo.
  pause
  exit /b 1
)

rem The default action is THE GAME (play.html). Extra arguments are passed
rem straight through to serve.py as either a port or a page keyword:
rem     start.bat viewer            open the scene viewer instead
rem     start.bat workbench         open the parametric floorplan workbench
rem     start.bat 9000              use another port
rem     start.bat 9000 workbench    both
%PY% serve.py %*

echo.
echo   Server stopped.
pause
