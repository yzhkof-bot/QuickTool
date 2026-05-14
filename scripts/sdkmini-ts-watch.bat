@echo off
setlocal
cd /d E:\sdkmini\Program\TsScripts || (
    echo [XX] Cannot cd into E:\sdkmini\Program\TsScripts
    exit /b 1
)
echo [STEP] cwd: %CD%
echo [STEP] npm run watch
call npm run watch
endlocal
