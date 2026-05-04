import sqlite3
import os

db_path = os.path.join(os.environ['APPDATA'], 'burger-orders', 'data', 'pedidos.db')
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Crear categoría Pizzas
cursor.execute("INSERT INTO categorias (nombre, tipo, color) VALUES (?, ?, ?)", ("Pizzas", "general", "#e74c3c"))
cat_id = cursor.lastrowid

# Crear producto Fugazza
cursor.execute("INSERT INTO productos (nombre, precio, categoria, stock_actual, categoria_id) VALUES (?, ?, ?, ?, ?)", 
               ("Fugazza", 5000, "Pizzas", 0, cat_id))

conn.commit()
conn.close()
print(f"Producto Fugazza creado con éxito en categoría Pizzas (ID: {cat_id})")
