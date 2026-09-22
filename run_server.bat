@echo off

REM === Kill all processes ===
echo Killing all processes...
for /f "tokens=2 delims=," %%i in ('tasklist /fo csv /nh ^| findstr "uvicorn.exe"') do (
    set pid=%%i
    set pid=%pid:~1,-1%
    echo Killed uvicorn %%pid
    taskkill /f /pid %%pid
)

REM Small delay
timeout /t 2 /nobreak >nul

REM Remove Qdrant lock
echo Removing Qdrant lock...
if exist "D:\Multi-Agent-Medical-Assistant-main\data\qdrant_db_v2\.lock" (
    del "D:\Multi-Agent-Medical-Assistant-main\data\qdrant_db_v2\.lock"
    echo Qdrant lock removed
) else (
    echo No Qdrant lock found
)

timeout /t 3 /nobreak >nul

REM Start fresh server
echo Starting fresh server...
start "server" /B "D:\Multi-Agent-Medical-Assistant-main\.venv\Scripts\python.exe" -m uvicorn app:app --host 0.0.0.0 --port 8000 --log-level info
cfg: Read configuration from: D:\Multi-Agent-Medical-Assistant-main\app.py
INFO:     Started server process [12612]
INFO:     Waiting for application startup.
INFO:     Application startup complete.
INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)
INFO:     127.0.0.1:58834 - "GET /health HTTP/1.1" 200 OK

REM Wait for health
for /l %%i in (1,1,10) do (
    timeout /t 2 /nobreak >nul
    curl -s http://127.0.0.1:8000/health >nul
    if errorlevel 0 (
        echo Health check OK
        goto health_ok
    ) else (
        echo Waiting for health... (attempt %%i)
    )
)
echo Health check failed
exit /b 1

:health_ok
echo Health check passed

REM Test home route
echo Testing home route...
curl -s http://127.0.0.1:8000/home >nul
if errorlevel 0 (
    echo Home route accessible
) else (
    echo Home route failed
    exit /b 1
)

REM Check if triage.js is being served
echo Checking triage.js in home page...
curl -s http://127.0.0.1:8000/home | findstr "triage.js"
if errorlevel 0 (
    echo SUCCESS: triage.js found in home page
) else (
    echo FAIL: triage.js not found in home page
)

REM Cleanup
echo Stopping server...

REM Find and kill the server process
for /f "tokens=2 delims=," %%i in ('tasklist /fo csv /nh ^| findstr "python.exe" ^| findstr "uvicorn"') do (
    set pid=%%i
    set pid=%pid:~1,-1%
    taskkill /f /pid %%pid
    echo Stopped server process %%pid
)

echo All tests completed successfully!
