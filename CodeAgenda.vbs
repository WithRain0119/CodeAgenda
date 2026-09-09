Option Explicit

Dim shell, fso, baseDir, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)

shell.CurrentDirectory = baseDir
command = "pythonw.exe tray.py"
shell.Run command, 0, False
