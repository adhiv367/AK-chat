path = "docker-compose.yml"
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

old = """    environment:
      NODE_ENV: production
      PORT: "3011\""""

new = """    environment:
      NODE_ENV: production
      PORT: "3011"
      DATABASE_URL: postgresql://postgres:postgres@akchat-db:5432/postgres"""

assert content.count(old) == 1, f"expected 1 match, found {content.count(old)}"
content = content.replace(old, new)

with open(path, "w", encoding="utf-8") as f:
    f.write(content)

print("Patched successfully.")
