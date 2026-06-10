:: Limpiar cache de iconos de Windows y recrear el acceso directo
:: Ejecuta con doble clic cuando cambies el icono

:: 1. Cerrar el Explorador de Windows
taskkill /f /im explorer.exe >nul 2>&1

:: 2. Borrar la cache de iconos
del /f /q "%localappdata%\IconCache.db" >nul 2>&1
del /f /q "%localappdata%\Microsoft\Windows\Explorer\iconcache*" >nul 2>&1
del /f /q "%localappdata%\Microsoft\Windows\Explorer\thumbcache*" >nul 2>&1

:: 3. Recrear el acceso directo con el icono nuevo
powershell -ExecutionPolicy Bypass -File "%~dp0Crear_Acceso_Directo.ps1"

:: 4. Reiniciar el Explorador
start explorer.exe

echo.
echo Listo! El icono fue actualizado.
pause
