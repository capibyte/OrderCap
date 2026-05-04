import sqlite3
import os

db_path = os.path.join(os.environ['APPDATA'], 'OrderCap', 'data', 'pedidos.db')
if os.path.exists(db_path):
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    tables = ['pedidos', 'recetas', 'productos', 'insumos', 'categorias']
    for t in tables:
        try:
            cursor.execute(f'DELETE FROM {t}')
            print(f'Tabla {t} limpiada')
        except Exception as e:
            print(f'Error en {t}: {e}')
    conn.commit()
    conn.close()
    print('Reinicio de base de datos completo.')
else:
    print('No se encontró el archivo de base de datos.')
