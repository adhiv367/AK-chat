import psycopg2

conn = psycopg2.connect("PASTE_THEIR_DATABASE_URL_HERE")
cur = conn.cursor()
cur.execute("SELECT id, name, language, body, status FROM coexistence.message_templates WHERE name = 'order_confirmation'")
for row in cur.fetchall():
    print("ID:", row[0])
    print("Name:", row[1])
    print("Language:", row[2])
    print("Status:", row[4])
    print("Body:")
    print(row[3])
conn.close()
