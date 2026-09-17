$path = "src/routes/webhook.js"
(Get-Content $path -Raw) -replace [regex]::Escape("router.post('/internal/send-order-confirmation', async (req, res) => {`n  try {"), "router.post('/internal/send-order-confirmation', async (req, res) => {`n  console.log('[PHASE4-DEBUG] Route handler entered. Body:', JSON.stringify(req.body));`n  try {" | Set-Content -Path $path -Encoding utf8NoBOM
