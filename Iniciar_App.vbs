' ============================================================
' Iniciar_App.vbs — Lanzador de Burger Orders
' Abre la aplicación sin mostrar la consola negra de CMD
' ============================================================
Set objShell = WScript.CreateObject("WScript.Shell")
objShell.CurrentDirectory = "C:\Users\Mica\Downloads\files"
objShell.Run "cmd.exe /c npm start", 0, False
