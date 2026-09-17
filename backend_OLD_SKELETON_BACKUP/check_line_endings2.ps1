$path = "src/routes/webhook.js"
$content = [System.IO.File]::ReadAllText($path)
$needle = "send-order-confirmation"
$idx = $content.IndexOf($needle)
Write-Host "Found at index: $idx"
if ($idx -ge 0) {
    $start = [Math]::Max(0, $idx - 20)
    $snippet = $content.Substring($start, 150)
    Write-Host "Snippet (escaped):"
    Write-Host ($snippet -replace "`r", "[CR]" -replace "`n", "[LF]")
}
