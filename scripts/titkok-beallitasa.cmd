@echo off
rem Dupla kattintassal ablakot nyit, ami rejtett beirassal bekeri a titkos adatokat (set-secrets.ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0set-secrets.ps1"
pause
