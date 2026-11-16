@echo off
setlocal
set "ROOT=%~dp0"
set "NODE=%ROOT%runtime\node.exe"
if not exist "%NODE%" set "NODE=%ROOT%assets\runtime\node.exe"
"%NODE%" "%ROOT%server\server.cjs" --data "%ROOT%data" --stop
if errorlevel 1 pause
