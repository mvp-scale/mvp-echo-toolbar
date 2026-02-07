# Fast MVP-Echo Downloader (PowerShell) 
# Downloads Python embedded + Whisper models quickly using Invoke-WebRequest

param(
    [string]$PythonVersion = "3.11.8",
    [switch]$AllModels = $false,
    [switch]$ModelsOnly = $false,
    [switch]$PythonOnly = $false
)

$ErrorActionPreference = "Stop"

# Configuration
$PYTHON_URL = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
$ROOT_DIR = Split-Path -Parent $PSScriptRoot
$TEMP_DIR = Join-Path $ROOT_DIR "temp"
$PYTHON_EMBEDDED_DIR = Join-Path $ROOT_DIR "python-embedded"
$MODELS_DIR = Join-Path $PYTHON_EMBEDDED_DIR "models"
$PYTHON_ZIP = Join-Path $TEMP_DIR "python-$PythonVersion-embed-amd64.zip"

# Model definitions
$MODELS = @(
    @{ name = "tiny"; size = "39MB"; url = "https://huggingface.co/openai/whisper-tiny/resolve/main/pytorch_model.bin" },
    @{ name = "base"; size = "74MB"; url = "https://huggingface.co/openai/whisper-base/resolve/main/pytorch_model.bin" },
    @{ name = "small"; size = "244MB"; url = "https://huggingface.co/openai/whisper-small/resolve/main/pytorch_model.bin" }
)

if ($AllModels) {
    $MODELS += @(
        @{ name = "medium"; size = "769MB"; url = "https://huggingface.co/openai/whisper-medium/resolve/main/pytorch_model.bin" },
        @{ name = "large"; size = "1550MB"; url = "https://huggingface.co/openai/whisper-large-v2/resolve/main/pytorch_model.bin" }
    )
}

Write-Host "[FAST-DOWNLOAD] MVP-Echo Fast Downloader" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Create directories
if (-not (Test-Path $TEMP_DIR)) {
    New-Item -ItemType Directory -Path $TEMP_DIR -Force | Out-Null
}

# Download Python embedded if needed
if (-not $ModelsOnly) {
    if (Test-Path $PYTHON_ZIP) {
        Write-Host "[SKIP] Python already downloaded" -ForegroundColor Yellow
    } else {
        Write-Host "[DOWNLOAD] Python $PythonVersion embedded (~25MB)..." -ForegroundColor Cyan
        $StartTime = Get-Date
        
        try {
            Invoke-WebRequest -Uri $PYTHON_URL -OutFile $PYTHON_ZIP -UseBasicParsing
            
            $EndTime = Get-Date
            $Duration = ($EndTime - $StartTime).TotalSeconds
            $FileSize = [math]::Round((Get-Item $PYTHON_ZIP).Length / 1MB, 1)
            $Speed = [math]::Round($FileSize / $Duration, 1)
            
            Write-Host "[SUCCESS] Python: $FileSize MB in $([math]::Round($Duration, 1))s ($Speed MB/s)" -ForegroundColor Green
        }
        catch {
            Write-Host "[ERROR] Failed to download Python: $($_.Exception.Message)" -ForegroundColor Red
            exit 1
        }
    }
}

# Download models if needed
if (-not $PythonOnly) {
    # Create models directory
    if (-not (Test-Path $MODELS_DIR)) {
        New-Item -ItemType Directory -Path $MODELS_DIR -Force | Out-Null
        Write-Host "[CREATE] Created models directory" -ForegroundColor Green
    }

    # Download each model
    $TotalDownloaded = 0
    foreach ($Model in $MODELS) {
        $ModelPath = Join-Path $MODELS_DIR "$($Model.name).pt"
        
        if (Test-Path $ModelPath) {
            $ExistingSize = [math]::Round((Get-Item $ModelPath).Length / 1MB, 1)
            Write-Host "[SKIP] $($Model.name) already exists ($ExistingSize MB)" -ForegroundColor Yellow
            continue
        }
        
        Write-Host "[DOWNLOAD] $($Model.name) model ($($Model.size))..." -ForegroundColor Cyan
        $StartTime = Get-Date
        
        try {
            Invoke-WebRequest -Uri $Model.url -OutFile $ModelPath -UseBasicParsing
            
            $EndTime = Get-Date
            $Duration = ($EndTime - $StartTime).TotalSeconds
            $FileSize = [math]::Round((Get-Item $ModelPath).Length / 1MB, 1)
            $Speed = [math]::Round($FileSize / $Duration, 1)
            
            Write-Host "[SUCCESS] $($Model.name): $FileSize MB in $([math]::Round($Duration, 1))s ($Speed MB/s)" -ForegroundColor Green
            $TotalDownloaded += $FileSize
        }
        catch {
            Write-Host "[ERROR] Failed to download $($Model.name): $($_.Exception.Message)" -ForegroundColor Red
        }
    }
    
    Write-Host ""
    if ($TotalDownloaded -gt 0) {
        Write-Host "[COMPLETE] Downloaded $([math]::Round($TotalDownloaded, 1)) MB of models" -ForegroundColor Green
    } else {
        Write-Host "[INFO] All models already present" -ForegroundColor Yellow
    }
}

# Summary
Write-Host ""
Write-Host "[SUMMARY] Download Status:" -ForegroundColor Cyan

if (Test-Path $PYTHON_ZIP) {
    $PythonSize = [math]::Round((Get-Item $PYTHON_ZIP).Length / 1MB, 1)
    Write-Host "  Python: $PythonSize MB ✓" -ForegroundColor Green
}

if (Test-Path $MODELS_DIR) {
    $ModelFiles = Get-ChildItem $MODELS_DIR -Filter "*.pt"
    $ModelCount = $ModelFiles.Count
    if ($ModelCount -gt 0) {
        Write-Host "  Models: $ModelCount files ✓" -ForegroundColor Green
        foreach ($ModelFile in $ModelFiles) {
            $SizeMB = [math]::Round($ModelFile.Length / 1MB, 1)
            Write-Host "    - $($ModelFile.BaseName): $SizeMB MB" -ForegroundColor Green
        }
    }
}

Write-Host ""
Write-Host "[NEXT STEPS]" -ForegroundColor Yellow
Write-Host "1. Run: npm run prepare:python:manual" -ForegroundColor Cyan
Write-Host "2. Run: npm run pack:portable:manual" -ForegroundColor Cyan
Write-Host ""
Write-Host "Downloads complete! Ready for fast build." -ForegroundColor Green