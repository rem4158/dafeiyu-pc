Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
python = fso.BuildPath(root, ".venv\Scripts\pythonw.exe")
If Not fso.FileExists(python) Then python = fso.BuildPath(root, "runtime\python\pythonw.exe")
If Not fso.FileExists(python) Then
    MsgBox "Set up Python and Electron as described in README.md before starting.", 48, "Dafeiyu PC"
    WScript.Quit 1
End If
script = fso.BuildPath(root, "launch.py")
shell.Run """" & python & """ """ & script & """", 0, False
