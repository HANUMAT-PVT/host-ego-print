@echo off
echo ========================================
echo Hostego Print - Windows Build Script
echo ========================================
echo.

REM Check if node_modules exists
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo ERROR: npm install failed
        pause
        exit /b 1
    )
)

REM Clean dist folder
echo.
echo Cleaning dist folder...
if exist "dist" rmdir /s /q dist

REM Build
echo.
echo Building Windows installer...
call npx electron-builder --win --x64

if errorlevel 1 (
    echo.
    echo ========================================
    echo BUILD FAILED
    echo ========================================
    echo.
    echo Common fixes:
    echo 1. Close any running Hostego Print instances
    echo 2. Disable antivirus temporarily
    echo 3. Run this script as Administrator
    echo 4. Delete node_modules and run: npm install
    echo.
    pause
    exit /b 1
)

echo.
echo ========================================
echo BUILD SUCCESSFUL!
echo ========================================
echo.
echo Output files:
echo   - Installer: dist\Hostego Print Setup 1.0.0.exe
echo   - Portable:  dist\win-unpacked\Hostego Print.exe
echo.
echo To test, run: dist\win-unpacked\Hostego Print.exe
echo.
pause
