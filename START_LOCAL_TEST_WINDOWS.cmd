@echo off
chcp 65001 >nul
where python >nul 2>nul
if errorlevel 1 (
  echo Python not found.
  pause
  exit /b 1
)
echo Opening local test server at http://127.0.0.1:8080
start "" http://127.0.0.1:8080
python -m http.server 8080
pause
