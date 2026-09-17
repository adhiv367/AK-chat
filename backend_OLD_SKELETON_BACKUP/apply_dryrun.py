path = "src/integrations/metaSend.js"

with open(path, "r", encoding="utf-8") as f:
    content = f.read()

old = """async function postJson(endpoint, accessToken, body) {
  const res = await fetch(endpoint, {"""

new = """async function postJson(endpoint, accessToken, body) {
  if (process.env.DRY_RUN_WHATSAPP_SEND === 'true') {
    console.log('[DRY RUN] Would send to Meta:', endpoint, JSON.stringify(body));
    return { messages: [{ id: `wamid.DRYRUN_${Date.now()}` }] };
  }

  const res = await fetch(endpoint, {"""

if content.count(old) != 1:
    print(f"ERROR: expected exactly 1 match, found {content.count(old)} — aborting, no changes made")
else:
    content = content.replace(old, new)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print("Change applied successfully.")
