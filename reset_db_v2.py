import sqlite3
import os

db_path = os.path.join(os.environ['APPDATA'], 'burger-orders', 'data', 'pedidos.db')
conn = sqlite3.connect(db_path)
cursor = conn.cursor()
tables = ['pedidos', 'recetas', 'productos', 'insumos', 'categorias', 'pedido_items']
for t in tables:
    try:
        # Verificar si la tabla existe
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (t,))
        if cursor.fetchone():
            cursor.execute(f"DELETE FROM {t}")
            print(f"Tabla {t} vaciada.")
    except Exception as e:
        print(f"Error al vaciar {t}: {e}")

conn.commit()
conn.close()
print("Reinicio de base de datos 'burger-orders' completado.")
