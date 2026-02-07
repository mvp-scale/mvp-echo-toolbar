# Download Whisper Tiny model for packaging
$modelUrl = "https://huggingface.co/openai/whisper-tiny/resolve/main/pytorch_model.bin"
$modelPath = "models\tiny.bin"

Write-Host "Downloading Whisper Tiny model (39MB)..." -ForegroundColor Cyan

# Create models directory if it doesn't exist
if (!(Test-Path "models")) {
    New-Item -ItemType Directory -Path "models" | Out-Null
}

# Download the model
try {
    $webClient = New-Object System.Net.WebClient
    $webClient.DownloadProgressChanged += {
        $percent = $_.ProgressPercentage
        Write-Progress -Activity "Downloading Tiny Model" -Status "$percent% Complete" -PercentComplete $percent
    }
    
    $webClient.DownloadFileAsync($modelUrl, $modelPath)
    
    while ($webClient.IsBusy) {
        Start-Sleep -Milliseconds 100
    }
    
    Write-Host "✓ Tiny model downloaded successfully!" -ForegroundColor Green
    
    # Check file size
    $fileSize = (Get-Item $modelPath).Length / 1MB
    Write-Host "Model size: $([math]::Round($fileSize, 2)) MB" -ForegroundColor Gray
    
} catch {
    Write-Host "✗ Failed to download model: $_" -ForegroundColor Red
    exit 1
}

Write-Host "`nTiny model ready for packaging!" -ForegroundColor Green