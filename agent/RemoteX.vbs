' RemoteX launcher — opens the app WITHOUT any console window.
' The app itself does NOT run elevated (Chromium screen capture breaks under elevation).
' Instead, a tiny one-shot admin helper handles ONLY the lid-close power setting —
' its single UAC prompt appears right after RemoteX opens (allow it to block lid-close sleep).
Option Explicit

Dim fso, shell, agentDir, exe
Set fso = CreateObject("Scripting.FileSystemObject")
agentDir = fso.GetParentFolderName(WScript.ScriptFullName)
exe = agentDir & "\node_modules\electron\dist\electron.exe"

If Not fso.FileExists(exe) Then
  MsgBox "Electron not found. Open a terminal, run npm install and npm run build, then try again.", vbExclamation, "RemoteX"
  WScript.Quit 1
End If

Set shell = CreateObject("Shell.Application")
shell.ShellExecute exe, """" & agentDir & """", "", "open", 1
