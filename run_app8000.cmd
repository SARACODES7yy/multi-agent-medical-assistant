@echo off
cd /d D:\Multi-Agent-Medical-Assistant-main
"D:\Multi-Agent-Medical-Assistant-main\.venv\Scripts\python.exe" -m uvicorn app:app --host 0.0.0.0 --port 8000 > "D:\Multi-Agent-Medical-Assistant-main\server80.log" 2>&1