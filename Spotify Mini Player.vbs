Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
folder = files.GetParentFolderName(WScript.ScriptFullName)
shell.Run Chr(34) & folder & "\Spotify Mini Player.bat" & Chr(34), 0, False
