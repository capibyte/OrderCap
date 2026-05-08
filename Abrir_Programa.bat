@echo off
title Iniciando Burger Orders...
echo Iniciando el programa optimizado...
npm start
if %errorlevel% neq 0 (
    echo.
    echo Ocurrio un error al iniciar. Asegurate de estar en la carpeta correcta.
    pause
)
