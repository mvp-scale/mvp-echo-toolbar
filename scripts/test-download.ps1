# Simple test script
Write-Host "Testing PowerShell syntax"

$ROOT_DIR = Split-Path -Parent $PSScriptRoot
$TEMP_DIR = Join-Path $ROOT_DIR "temp"

Write-Host "Root dir: $ROOT_DIR"
Write-Host "Temp dir: $TEMP_DIR"

if (Test-Path $TEMP_DIR) {
    Write-Host "Temp directory exists"
} else {
    Write-Host "Temp directory does not exist"
}

Write-Host "Test complete"