' Dual AI Chat launcher: opens the app window, starting the hidden background server first if needed.
' - Server already running: just open the window (do not start a second server; its log file is in use).
' - Not running: start "node server.mjs" hidden, wait until it answers, then open the window.
' Uses the portable Node in runtime\node (installed by install.bat) when present.
' To stop the server: Settings (bottom-left) -> "Stop background service".
Option Explicit
Dim fso, sh, root, port, url, node, portable, logFile, i
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root
If Not fso.FolderExists("data") Then fso.CreateFolder("data")

port = sh.ExpandEnvironmentStrings("%DUAL_CHAT_PORT%")
If port = "%DUAL_CHAT_PORT%" Or port = "" Then port = "8796"
url = "http://127.0.0.1:" & port & "/"

Function ServerUp()
  Dim http
  ServerUp = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1000, 1000, 1000, 1500
  http.open "GET", url & "api/health", False
  http.send
  If Err.Number = 0 Then ServerUp = (http.status = 200)
  Err.Clear
  On Error GoTo 0
End Function

Function FindBrowser()
  Dim candidates, c
  candidates = Array( _
    "%ProgramFiles%\Google\Chrome\Application\chrome.exe", _
    "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe", _
    "%LocalAppData%\Google\Chrome\Application\chrome.exe", _
    "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe", _
    "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe")
  FindBrowser = ""
  For Each c In candidates
    c = sh.ExpandEnvironmentStrings(c)
    If fso.FileExists(c) Then
      FindBrowser = c
      Exit Function
    End If
  Next
End Function

Sub OpenWindow()
  Dim browser
  If sh.ExpandEnvironmentStrings("%DUAL_CHAT_NO_WINDOW%") = "1" Then Exit Sub
  browser = FindBrowser()
  If browser <> "" Then
    sh.Run """" & browser & """ --app=" & url & " --window-size=1360,900", 1, False
  Else
    sh.Run url, 1, False
  End If
End Sub

If Not ServerUp() Then
  node = "node"
  portable = fso.BuildPath(root, "runtime\node\node.exe")
  If fso.FileExists(portable) Then node = """" & portable & """"
  ' one log per port: a server already running on another port keeps its own log open
  logFile = "data\launcher.log"
  If port <> "8796" Then logFile = "data\launcher-" & port & ".log"
  ' cmd /c strips the outermost quotes, so wrap the whole command once more
  sh.Run "cmd /c """ & node & " server.mjs >> " & logFile & " 2>&1""", 0, False
  For i = 1 To 60
    WScript.Sleep 500
    If ServerUp() Then Exit For
  Next
End If

OpenWindow
