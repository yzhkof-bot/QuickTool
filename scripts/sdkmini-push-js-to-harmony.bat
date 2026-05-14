@echo off
setlocal
cd /d E:\sdkmini\Program\TsScripts || (
    echo [XX] Cannot cd into E:\sdkmini\Program\TsScripts
    exit /b 1
)
echo [STEP] cwd: %CD%
echo [STEP] npm run tool:pushJSToHarmony
call npm run tool:pushJSToHarmony
echo.
echo [DONE] exit code: %ERRORLEVEL%
pause
endlocal
