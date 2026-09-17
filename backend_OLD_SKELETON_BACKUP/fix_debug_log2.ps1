$path = "src/routes/webhook.js"
$content = Get-Content -Path $path -Raw
$old = "router.post('/internal/send-order-confirmation', async (req, res) => {`r`n  try {"
$new = "router.post('/internal/send-order-confirmation', async (req, res) => {`r`n  console.log('[PHASE4-DEBUG] Route handler entered. Body:', JSON.stringify(req.body));`r`n  try {"
if ($content.IndexOf($old) -lt 0) {
    Write-Host "ERROR: target text not found"
} elseif (([regex]::Matches($content, [regex]::Escape($old))).Count -ne 1) {
    Write-Host "ERROR: target text not unique"
} else {
    $newContent = $content.Replace($old, $new)
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($path, $newContent, $utf8NoBom)
    Write-Host "Debug log added successfully."
}
