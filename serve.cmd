@echo off
REM Optional fallback. The preview is designed to run by double-clicking
REM index.html, with no server at all. Use this only if your browser is
REM configured to block local files.
cd /d "%~dp0"
echo Serving this folder at http://localhost:8099
echo Press Ctrl+C to stop.
start "" http://localhost:8099/index.html
py -m http.server 8099 2>nul || python -m http.server 8099
