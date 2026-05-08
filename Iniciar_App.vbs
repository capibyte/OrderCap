Set WshShell = CreateObject("WScript.Shell")
' Ejecuta el comando npm start de forma oculta (0)
WshShell.Run "cmd.exe /c npm start", 0, false
