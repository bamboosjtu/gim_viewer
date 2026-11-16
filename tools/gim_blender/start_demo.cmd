@echo off
setlocal
set "ROOT=%~dp0"
set "NODE=%ROOT%runtime\node.exe"
set "WEB=%ROOT%demo"
if not exist "%NODE%" set "NODE=%ROOT%assets\runtime\node.exe"
if not exist "%WEB%\index.html" set "WEB=%ROOT%assets\web"
"%NODE%" "%ROOT%server\server.cjs" --data "%ROOT%data" --runtime "%WEB%" --port 8765 --open %*
if errorlevel 1 pause
