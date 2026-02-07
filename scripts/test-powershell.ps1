# Simple test script to verify PowerShell syntax is correct
# Run this to verify the prepare-python.ps1 script doesn't have syntax errors

param(
    [switch]$TestSyntax = $false
)

Write-Host "[TEST] Testing PowerShell script syntax..." -ForegroundColor Cyan

try {
    # Test syntax by parsing the script
    $ScriptPath = Join-Path $PSScriptRoot "prepare-python.ps1"
    
    if (-not (Test-Path $ScriptPath)) {
        Write-Host "[ERROR] Script not found: $ScriptPath" -ForegroundColor Red
        exit 1
    }
    
    # Parse the script content to check for syntax errors
    $ScriptContent = Get-Content $ScriptPath -Raw
    $ScriptBlock = [ScriptBlock]::Create($ScriptContent)
    
    if ($ScriptBlock) {
        Write-Host "[SUCCESS] PowerShell script syntax is valid!" -ForegroundColor Green
        
        if ($TestSyntax) {
            Write-Host "[INFO] Running syntax-only test..." -ForegroundColor Yellow
            # Run with -Clean flag to test function without downloading
            & $ScriptPath -Clean
        }
    }
}
catch {
    Write-Host "[ERROR] PowerShell script has syntax errors:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

Write-Host "[DONE] PowerShell script validation completed" -ForegroundColor Green