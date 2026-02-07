# PowerShell script to prepare whisper.cpp native binary
param(
    [switch]$Clean = $false
)

$ErrorActionPreference = "Stop"

# Paths
$binDir = "whisper-bin"
$modelsDir = "models"
$whisperExe = "$binDir\whisper.exe"
$tinyModel = "$modelsDir\ggml-tiny.bin"

# Clean mode
if ($Clean) {
    Write-Host "Cleaning whisper native files..." -ForegroundColor Yellow
    if (Test-Path $binDir) {
        Remove-Item -Path $binDir -Recurse -Force
        Write-Host "✓ Removed $binDir" -ForegroundColor Green
    }
    exit 0
}

Write-Host "`n🎯 Preparing Whisper Native Engine" -ForegroundColor Cyan
Write-Host "==================================`n" -ForegroundColor Cyan

# Create directories
if (!(Test-Path $binDir)) {
    New-Item -ItemType Directory -Path $binDir | Out-Null
    Write-Host "✓ Created $binDir directory" -ForegroundColor Green
}

if (!(Test-Path $modelsDir)) {
    New-Item -ItemType Directory -Path $modelsDir | Out-Null
    Write-Host "✓ Created $modelsDir directory" -ForegroundColor Green
}

# Download whisper.cpp binary if not present
if (!(Test-Path $whisperExe)) {
    Write-Host "`nDownloading whisper.cpp binary..." -ForegroundColor Yellow
    
    # Get latest release from GitHub
    $releaseUrl = "https://api.github.com/repos/ggerganov/whisper.cpp/releases/latest"
    $release = Invoke-RestMethod -Uri $releaseUrl
    
    # Find Windows binary
    $asset = $release.assets | Where-Object { $_.name -like "*win*x64*.zip" } | Select-Object -First 1
    
    if ($asset) {
        $downloadUrl = $asset.browser_download_url
        $zipFile = "$binDir\whisper-win.zip"
        
        Write-Host "Downloading from: $downloadUrl" -ForegroundColor Gray
        Invoke-WebRequest -Uri $downloadUrl -OutFile $zipFile
        
        # Extract
        Expand-Archive -Path $zipFile -DestinationPath $binDir -Force
        Remove-Item $zipFile
        
        # Find the exe in extracted files
        $extractedExe = Get-ChildItem -Path $binDir -Filter "*.exe" -Recurse | Select-Object -First 1
        if ($extractedExe) {
            Move-Item $extractedExe.FullName $whisperExe -Force
            Write-Host "✓ Whisper binary ready" -ForegroundColor Green
        }
    } else {
        Write-Host "⚠ Could not find Windows binary, will compile from source" -ForegroundColor Yellow
        
        # Alternative: compile from source
        Write-Host "Cloning whisper.cpp repository..." -ForegroundColor Yellow
        git clone https://github.com/ggerganov/whisper.cpp.git "$binDir\source"
        
        Set-Location "$binDir\source"
        
        # Build with CMake
        Write-Host "Building whisper.cpp..." -ForegroundColor Yellow
        cmake -B build
        cmake --build build --config Release
        
        # Copy binary
        Copy-Item "build\bin\Release\main.exe" "..\..\$whisperExe"
        
        Set-Location "..\..\"
        Remove-Item -Path "$binDir\source" -Recurse -Force
        
        Write-Host "✓ Built whisper.cpp from source" -ForegroundColor Green
    }
} else {
    Write-Host "✓ Whisper binary already exists" -ForegroundColor Green
}

# Download tiny model if not present
if (!(Test-Path $tinyModel)) {
    Write-Host "`nDownloading Whisper Tiny model (39MB)..." -ForegroundColor Yellow
    
    $modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin"
    
    # Download with progress
    $webClient = New-Object System.Net.WebClient
    $webClient.DownloadProgressChanged += {
        $percent = $_.ProgressPercentage
        Write-Progress -Activity "Downloading Tiny Model" -Status "$percent% Complete" -PercentComplete $percent
    }
    
    Register-ObjectEvent -InputObject $webClient -EventName DownloadFileCompleted -Action {
        Write-Progress -Activity "Downloading Tiny Model" -Completed
    } | Out-Null
    
    $webClient.DownloadFileAsync($modelUrl, $tinyModel)
    
    while ($webClient.IsBusy) {
        Start-Sleep -Milliseconds 100
    }
    
    Write-Host "✓ Tiny model downloaded" -ForegroundColor Green
} else {
    Write-Host "✓ Tiny model already exists" -ForegroundColor Green
}

# Test the setup
Write-Host "`nTesting whisper.cpp setup..." -ForegroundColor Yellow
try {
    $testOutput = & $whisperExe --help 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✓ Whisper.cpp is working!" -ForegroundColor Green
    } else {
        Write-Host "✗ Whisper.cpp test failed" -ForegroundColor Red
    }
} catch {
    Write-Host "✗ Could not run whisper.cpp: $_" -ForegroundColor Red
}

Write-Host "`n✅ Whisper Native Engine Ready!" -ForegroundColor Green
Write-Host "==================================`n" -ForegroundColor Green

# Summary
Write-Host "Summary:" -ForegroundColor Cyan
Write-Host "  • Binary: $whisperExe" -ForegroundColor Gray
Write-Host "  • Model: $tinyModel (39MB)" -ForegroundColor Gray
Write-Host "  • Works immediately without internet" -ForegroundColor Gray
Write-Host "  • GPU acceleration if available" -ForegroundColor Gray
Write-Host "`nUsers can upgrade to Python/Faster-Whisper for better performance" -ForegroundColor Yellow