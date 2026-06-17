@echo off
cd /d E:\sdkmini\Program\TsScripts
if errorlevel 1 (
    echo [XX] Cannot cd into E:\sdkmini\Program\TsScripts
    goto :end
)

echo [STEP] cwd: %CD%
echo [STEP] npm run tool:pushJSToHarmony
echo.

cmd /c "npm run tool:pushJSToHarmony"
set "RC=%ERRORLEVEL%"

echo.
echo ============================================================
if "%RC%"=="0" (
    echo [OK] tool:pushJSToHarmony succeeded ^(exit code: %RC%^)
) else (
    echo [XX] tool:pushJSToHarmony FAILED ^(exit code: %RC%^)
)
echo ============================================================
echo.

:end
echo Press any key to close this window...
pause >nul
