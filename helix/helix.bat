@echo off
REM Portable launcher for Windows. See helix.sh for the reasoning.
setlocal
set "DIR=%~dp0"
cd /d "%DIR%"

where node >nul 2>nul || (echo Helix needs Node on this machine, and it is not installed. & exit /b 1)
where python >nul 2>nul || (echo Helix needs Python on this machine, and it is not installed. & exit /b 1)

set "HELIX_DATA=%DIR%"
if not exist "%DIR%models" mkdir "%DIR%models"
if not exist "%DIR%vault" mkdir "%DIR%vault"

if not exist node_modules (
  echo First run on this machine: installing dependencies...
  call npm ci --legacy-peer-deps
)

echo Helix data root: %DIR%
call npm run server
