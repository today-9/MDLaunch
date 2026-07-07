@echo off
rem MDLaunch 起動(ログが見えるデバッグ用。普段は MDLaunch.vbs 推奨)
cd /d "%~dp0"
uv run python -m app.launch
pause
