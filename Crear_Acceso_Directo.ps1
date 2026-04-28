$destino = 'C:\Users\Mica\Downloads\files\Burger Orders.lnk'
$iconoPath = 'C:\Users\Mica\Downloads\files\assets\icon.ico'
$vbsPath = 'C:\Users\Mica\Downloads\files\Iniciar_App.vbs'
$WshShell = New-Object -ComObject WScript.Shell
$acceso = $WshShell.CreateShortcut($destino)
$acceso.TargetPath = 'wscript.exe'
$acceso.Arguments = "`"$vbsPath`""
$acceso.WorkingDirectory = 'C:\Users\Mica\Downloads\files'
$acceso.Description = 'Burger Orders'
$acceso.IconLocation = "$iconoPath,0"
$acceso.Save()
Write-Host "OK - Acceso directo creado en la carpeta files"
