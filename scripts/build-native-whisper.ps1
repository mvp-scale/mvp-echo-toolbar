# MVP-Echo: Build Native Whisper Integration Script
# Builds standalone whisper and integrates it into the main app
param(
    [switch]$Clean = $false,
    [switch]$Test = $false
)

$ErrorActionPreference = "Stop"

Write-Host "`n🎯 MVP-Echo: Building Native Whisper Engine" -ForegroundColor Cyan
Write-Host "==========================================`n" -ForegroundColor Cyan

# Paths
$standaloneDir = "standalone-whisper"
$outputDir = "whisper-bin"
$exeName = "whisper-standalone.exe"

# Clean mode
if ($Clean) {
    Write-Host "🧹 Cleaning native whisper build..." -ForegroundColor Yellow
    
    # Clean standalone build
    if (Test-Path $standaloneDir) {
        Push-Location $standaloneDir
        try {
            powershell -ExecutionPolicy Bypass -File build.ps1 -Clean
        } finally {
            Pop-Location
        }
    }
    
    # Clean integration
    if (Test-Path $outputDir) {
        Remove-Item -Path "$outputDir\$exeName" -Force -ErrorAction SilentlyContinue
        Write-Host "   ✓ Removed $outputDir\$exeName" -ForegroundColor Gray
    }
    
    Write-Host "✅ Clean complete!" -ForegroundColor Green
    exit 0
}

# Check standalone directory
if (!(Test-Path $standaloneDir)) {
    Write-Host "❌ Standalone whisper directory not found: $standaloneDir" -ForegroundColor Red
    Write-Host "   This should contain the isolated build environment." -ForegroundColor Gray
    exit 1
}

# Stage 1: Build standalone executable
Write-Host "🏗️ Stage 1: Building standalone executable..." -ForegroundColor Yellow
Write-Host "   Working in: $standaloneDir" -ForegroundColor Gray

Push-Location $standaloneDir
try {
    # Build the standalone executable
    $buildArgs = @()
    if ($Test) { $buildArgs += "-Test" }
    
    powershell -ExecutionPolicy Bypass -File build.ps1 @buildArgs
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Standalone build failed" -ForegroundColor Red
        exit 1
    }
    
    # Check if executable was created
    $standalonePath = "dist\$exeName"
    if (!(Test-Path $standalonePath)) {
        Write-Host "❌ Executable not found: $standalonePath" -ForegroundColor Red
        exit 1
    }
    
    $fileInfo = Get-Item $standalonePath
    $sizeMB = [math]::Round($fileInfo.Length / 1MB, 1)
    Write-Host "✅ Stage 1 complete: $sizeMB MB executable ready" -ForegroundColor Green
    
} finally {
    Pop-Location
}

# Stage 2: Integrate into main app
Write-Host "`n🔗 Stage 2: Integrating into MVP-Echo..." -ForegroundColor Yellow

# Create whisper-bin directory
if (!(Test-Path $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir | Out-Null
    Write-Host "   ✓ Created $outputDir directory" -ForegroundColor Gray
}

# Copy executable
$sourcePath = "$standaloneDir\dist\$exeName"
$destPath = "$outputDir\$exeName"

try {
    Copy-Item $sourcePath $destPath -Force
    Write-Host "   ✓ Copied $exeName to $outputDir" -ForegroundColor Gray
    
    # Verify copy
    if (Test-Path $destPath) {
        $destInfo = Get-Item $destPath
        $destSizeMB = [math]::Round($destInfo.Length / 1MB, 1)
        Write-Host "   ✓ Verified: $destSizeMB MB" -ForegroundColor Gray
    } else {
        Write-Host "❌ Copy verification failed" -ForegroundColor Red
        exit 1
    }
    
} catch {
    Write-Host "❌ Failed to copy executable: $_" -ForegroundColor Red
    exit 1
}

Write-Host "✅ Stage 2 complete: Native engine integrated" -ForegroundColor Green

# Final verification
Write-Host "`n🧪 Final verification..." -ForegroundColor Yellow
try {
    $testOutput = & $destPath --version 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "   ✓ Executable test passed: $testOutput" -ForegroundColor Green
    } else {
        Write-Host "   ⚠️ Executable test warning (exit code $LASTEXITCODE)" -ForegroundColor Yellow
    }
} catch {
    Write-Host "   ❌ Final verification failed: $_" -ForegroundColor Red
    exit 1
}

Write-Host "`n🎉 Native Whisper Engine Ready!" -ForegroundColor Green
Write-Host "===============================" -ForegroundColor Green

Write-Host "`n📁 Files created:" -ForegroundColor Cyan
Write-Host "   • $destPath (native executable)" -ForegroundColor Gray
Write-Host "   • Ready for electron-builder packaging" -ForegroundColor Gray

Write-Host "`n🚀 Next steps:" -ForegroundColor Cyan  
Write-Host "   npm run pack    # Package MVP-Echo with native engine" -ForegroundColor Gray
Write-Host "   npm run dist    # Create installer with native engine" -ForegroundColor Gray

Write-Host "`n✨ This gives you:" -ForegroundColor Yellow
Write-Host "   • Native Faster-Whisper (no Python required)" -ForegroundColor Gray
Write-Host "   • GPU acceleration out-of-the-box" -ForegroundColor Gray
Write-Host "   • Same technology as Python upgrade path" -ForegroundColor Gray
Write-Host "   • Models auto-download on first use" -ForegroundColor Gray
Write-Host "   • Complete offline operation after setup" -ForegroundColor Gray