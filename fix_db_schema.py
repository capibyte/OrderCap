import sqlite3
import os

db_path = os.path.join(os.environ['APPDATA'], 'burger-orders', 'data', 'pedidos.db')
if os.path.exists(db_path):
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # SQLite no permite ALTER TABLE para cambiar NOT NULL fácilmente.
    # La forma segura es recrear la tabla o simplemente asegurar que los valores existan.
    # Pero aquí vamos a intentar la técnica de renombrar y recrear.
    
    try:
        cursor.execute("PRAGMA foreign_keys=OFF")
        cursor.execute("BEGIN TRANSACTION")
        
        # 1. Renombrar tabla vieja
        cursor.execute("ALTER TABLE productos RENAME TO productos_old")
        
        # 2. Crear tabla nueva con el esquema correcto (categoria nullable)
        cursor.execute("""
            CREATE TABLE productos (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              nombre TEXT NOT NULL,
              precio REAL NOT NULL,
              categoria TEXT, 
              stock_actual INTEGER DEFAULT 0,
              categoria_id INTEGER REFERENCES categorias(id)
            )
        """)
        
        # 3. Migrar datos
        cursor.execute("""
            INSERT INTO productos (id, nombre, precio, categoria, stock_actual, categoria_id)
            SELECT id, nombre, precio, categoria, stock_actual, categoria_id FROM productos_old
        """)
        
        # 4. Borrar tabla vieja
        cursor.execute("DROP TABLE productos_old")
        
        conn.commit()
        print("Esquema de tabla 'productos' actualizado con éxito.")
    except Exception as e:
        conn.rollback()
        print(f"Error al migrar tabla: {e}")
    finally:
        conn.close()
else:
    print("No se encontró la base de datos.")
