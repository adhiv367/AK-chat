$path = "src/routes/webhook.js"
$bytes = [System.IO.File]::ReadAllBytes($path)
$hasBOM = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
Write-Host "Has BOM: $hasBOM"

$content = [System.IO.File]::ReadAllText($path)
$idx = $content.IndexOf("router.post(`'/internal/send-order-confirmation`'")
Write-Host "Found route at index: $idx"
if ($idx -ge 0) {
    $snippet = $content.Substring($idx, 80)
    Write-Host "Snippet (escaped):"
    Write-Host ($snippet -replace "`r", "[CR]" -replace "`n", "[LF]")
}
