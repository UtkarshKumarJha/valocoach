import sqlite3
import pandas as pd

conn = sqlite3.connect('datasets/valorant.sqlite')
tables = conn.execute("SELECT name FROM sqlite_master WHERE type='table';").fetchall()
print("Tables:", tables)

for t in tables:
    table_name = t[0]
    print(f"\n--- Schema for {table_name} ---")
    df = pd.read_sql_query(f"SELECT * FROM {table_name} LIMIT 1", conn)
    print(df.columns.tolist())
