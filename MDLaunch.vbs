' MDLaunch launcher (no console window).
' If the server is already running, it just opens a browser tab.
' To stop the server, use the "quit" button in the app sidebar.
' NOTE: keep this file ASCII-only; WSH reads .vbs as ANSI.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c uv run python -m app.launch", 0, False
