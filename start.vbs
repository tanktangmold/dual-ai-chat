' Dual AI Chat launcher: runs the server hidden and opens http://127.0.0.1:8796 in an app window.
' If the server is already running, it only opens the window.
' Uses the portable Node in runtime\node (installed by the one-click installer) when present.
' To stop the server: Settings (bottom-left) -> "close background service".
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root
If Not fso.FolderExists("data") Then fso.CreateFolder("data")

node = "node"
portable = fso.BuildPath(root, "runtime\node\node.exe")
If fso.FileExists(portable) Then node = """" & portable & """"

' cmd /c strips the outermost quotes, so wrap the whole command once more
inner = node & " server.mjs --open >> data\launcher.log 2>&1"
sh.Run "cmd /c """ & inner & """", 0, False
