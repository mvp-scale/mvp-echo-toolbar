# Fast MVP-Echo Downloader
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

# Model definitions - only essential models by default
$MODELS = @(
    @{ name = "tiny"; url = "https://huggingface.co/openai/whisper-tiny/resolve/main/pytorch_model.bin" },
    @{ name = "base"; url = "https://huggingface.co/openai/whisper-base/resolve/main/pytorch_model.bin" },
    @{ name = "small"; url = "https://huggingface.co/openai/whisper-small/resolve/main/pytorch_model.bin" }
)

if ($AllModels) {
    $MODELS += @(
        @{ name = "medium"; url = "https://huggingface.co/openai/whisper-medium/resolve/main/pytorch_model.bin" },
        @{ name = "large"; url = "https://huggingface.co/openai/whisper-large-v2/resolve/main/pytorch_model.bin" }
    )
}

Write-Host "[FAST-DOWNLOAD] MVP-Echo Fast Downloader" -ForegroundColor Cyan

# Create temp directory
if (-not (Test-Path $TEMP_DIR)) {
    New-Item -ItemType Directory -Path $TEMP_DIR -Force | Out-Null
}

# Download Python if requested
if (-not $ModelsOnly) {
    if (Test-Path $PYTHON_ZIP) {
        Write-Host "[SKIP] Python already downloaded" -ForegroundColor Yellow
    } else {
        Write-Host "[DOWNLOAD] Python $PythonVersion..." -ForegroundColor Cyan
        try {
            Invoke-WebRequest -Uri $PYTHON_URL -OutFile $PYTHON_ZIP -UseBasicParsing
            $FileSize = [math]::Round((Get-Item $PYTHON_ZIP).Length / 1MB, 1)
            Write-Host "[SUCCESS] Python downloaded: $FileSize MB" -ForegroundColor Green
        }
        catch {
            Write-Host "[ERROR] Failed to download Python: $($_.Exception.Message)" -ForegroundColor Red
            exit 1
        }
    }
}

# Download models if requested
if (-not $PythonOnly) {
    if (-not (Test-Path $MODELS_DIR)) {
        New-Item -ItemType Directory -Path $MODELS_DIR -Force | Out-Null
    }

    foreach ($Model in $MODELS) {
        $ModelPath = Join-Path $MODELS_DIR "$($Model.name).pt"
        
        if (Test-Path $ModelPath) {
            Write-Host "[SKIP] $($Model.name) already exists" -ForegroundColor Yellow
            continue
        }
        
        Write-Host "[DOWNLOAD] $($Model.name) model..." -ForegroundColor Cyan
        try {
            Invoke-WebRequest -Uri $Model.url -OutFile $ModelPath -UseBasicParsing
            $FileSize = [math]::Round((Get-Item $ModelPath).Length / 1MB, 1)
            Write-Host "[SUCCESS] $($Model.name): $FileSize MB" -ForegroundColor Green
        }
        catch {
            Write-Host "[ERROR] Failed to download $($Model.name): $($_.Exception.Message)" -ForegroundColor Red
        }
    }
}

Write-Host ""
Write-Host "[COMPLETE] Fast download finished!" -ForegroundColor Green
Write-Host "Next: Run 'npm run prepare:python:manual'" -ForegroundColor Cyan