# MVP-Echo Python Embedded Distribution Preparation Script (PowerShell)
# This script downloads and prepares a Python embedded distribution for portable MVP-Echo

param(
    [string]$PythonVersion = "3.11.8",
    [switch]$SkipDownload = $false,
    [switch]$SkipModels = $false,
    [switch]$EssentialModels = $false,
    [switch]$AllModels = $false,
    [switch]$Clean = $false
)

$ErrorActionPreference = "Stop"

# Configuration
$PYTHON_EMBEDDED_URL = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
$ROOT_DIR = Split-Path -Parent $PSScriptRoot
$TEMP_DIR = Join-Path $ROOT_DIR "temp"
$PYTHON_EMBEDDED_DIR = Join-Path $ROOT_DIR "python-embedded"
$PYTHON_ZIP = Join-Path $TEMP_DIR "python-$PythonVersion-embed-amd64.zip"

# Required Python packages
$REQUIRED_PACKAGES = @(
    "faster-whisper",
    "numpy",
    "torch",
    "torchaudio",
    "onnxruntime"
)

# Whisper models to download (using fast Hugging Face URLs)
$WHISPER_MODELS = @(
    @{ name = "tiny"; size = "39MB"; url = "https://huggingface.co/openai/whisper-tiny/resolve/main/pytorch_model.bin" },
    @{ name = "base"; size = "74MB"; url = "https://huggingface.co/openai/whisper-base/resolve/main/pytorch_model.bin" },
    @{ name = "small"; size = "244MB"; url = "https://huggingface.co/openai/whisper-small/resolve/main/pytorch_model.bin" },
    @{ name = "medium"; size = "769MB"; url = "https://huggingface.co/openai/whisper-medium/resolve/main/pytorch_model.bin" },
    @{ name = "large"; size = "1550MB"; url = "https://huggingface.co/openai/whisper-large-v2/resolve/main/pytorch_model.bin" }
)

function Write-Status {
    param([string]$Message, [string]$Icon = "[INFO]")
    Write-Host "$Icon $Message" -ForegroundColor Green
}

function Write-ErrorMsg {
    param([string]$Message)
    Write-Host "[ERROR] $Message" -ForegroundColor Red
}

function Download-File {
    param([string]$Url, [string]$Destination)
    
    Write-Status "Downloading $Url..." "[DOWNLOAD]"
    
    try {
        $ProgressPreference = 'Continue'
        Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
        Write-Status "Download completed" "[DONE]"
    }
    catch {
        Write-ErrorMsg "Failed to download: $($_.Exception.Message)"
        throw
    }
}

function Extract-PythonZip {
    param([string]$ZipPath, [string]$ExtractPath)
    
    Write-Status "Extracting Python embedded distribution..." "[EXTRACT]"
    
    try {
        if (Test-Path $ExtractPath) {
            Remove-Item $ExtractPath -Recurse -Force
        }
        
        New-Item -ItemType Directory -Path $ExtractPath -Force | Out-Null
        Expand-Archive -Path $ZipPath -DestinationPath $ExtractPath -Force
        
        Write-Status "Extraction completed" "[DONE]"
    }
    catch {
        Write-ErrorMsg "Failed to extract: $($_.Exception.Message)"
        throw
    }
}

function Install-PythonPackages {
    param([string]$PythonPath)
    
    Write-Status "Installing required Python packages..." "[INSTALL]"
    
    # Download get-pip.py
    $PythonDir = Split-Path $PythonPath
    $GetPipPath = Join-Path $PythonDir "get-pip.py"
    
    try {
        Download-File "https://bootstrap.pypa.io/get-pip.py" $GetPipPath
        
        # Install pip
        Write-Status "Installing pip..." "[PIP]"
        & $PythonPath $GetPipPath
        
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to install pip"
        }
        
        # Try to use pip.exe directly first, then fall back to python -m pip
        $PipExe = Join-Path $PythonDir "Scripts\pip.exe"
        
        # Install packages
        foreach ($Package in $REQUIRED_PACKAGES) {
            Write-Status "Installing $Package..." "[PKG]"
            
            # Try pip.exe first
            if (Test-Path $PipExe) {
                & $PipExe install $Package --no-warn-script-location
            } else {
                # Fallback to python -m pip
                & $PythonPath -m pip install $Package --no-warn-script-location
            }
            
            if ($LASTEXITCODE -ne 0) {
                Write-ErrorMsg "Failed to install $Package"
                throw "Package installation failed"
            }
        }
        
        Write-Status "All packages installed successfully" "[DONE]"
    }
    catch {
        Write-ErrorMsg "Failed to install packages: $($_.Exception.Message)"
        throw
    }
}

function Create-PortableConfig {
    param([string]$PythonDir)
    
    Write-Status "Creating portable Python configuration..." "[CONFIG]"
    
    # Remove any existing _pth files that might interfere
    Get-ChildItem -Path $PythonDir -Filter "*._pth" | Remove-Item -Force -ErrorAction SilentlyContinue
    
    # Create python311._pth file with proper paths
    $PthContent = @"
python311.zip
.
Lib
Lib/site-packages
Scripts

# Enable site module for pip to work
import site
"@
    
    $PthPath = Join-Path $PythonDir "python311._pth"
    # Use UTF8NoBOM to avoid BOM issues that can corrupt Python paths
    $Utf8NoBomEncoding = New-Object System.Text.UTF8Encoding $False
    [System.IO.File]::WriteAllText($PthPath, $PthContent, $Utf8NoBomEncoding)
    
    Write-Status "Created python311._pth without BOM" "[PTH]"
    
    # Copy whisper_service.py to Python directory
    $WhisperServiceSrc = Join-Path $ROOT_DIR "python\whisper_service.py"
    $WhisperServiceDst = Join-Path $PythonDir "whisper_service.py"
    
    if (Test-Path $WhisperServiceSrc) {
        Copy-Item $WhisperServiceSrc $WhisperServiceDst
        Write-Status "Copied whisper_service.py to Python directory" "[COPY]"
    }
    else {
        Write-Host "[WARN] whisper_service.py not found at $WhisperServiceSrc" -ForegroundColor Yellow
    }
    
    Write-Status "Portable configuration created" "[DONE]"
}

function Get-FolderSize {
    param([string]$FolderPath)
    
    try {
        $Size = (Get-ChildItem $FolderPath -Recurse | Measure-Object -Property Length -Sum).Sum
        return [math]::Round($Size / 1MB, 1)
    }
    catch {
        return "Unknown"
    }
}

function Setup-WhisperModels {
    param([string]$PythonDir, [bool]$SkipDownloads = $false, [string]$ModelSet = "essential")
    
    # Create models directory
    $ModelsDir = Join-Path $PythonDir "models"
    if (-not (Test-Path $ModelsDir)) {
        New-Item -ItemType Directory -Path $ModelsDir -Force | Out-Null
        Write-Status "Created models directory" "[MODELS]"
    }
    
    # Check for pre-downloaded models in project root
    $PreDownloadedModelsDir = Join-Path $ROOT_DIR "models"
    $EssentialModels = @("tiny", "base", "small")
    
    if (Test-Path $PreDownloadedModelsDir) {
        Write-Status "Found pre-downloaded models directory" "[FOUND]"
        
        # Copy pre-downloaded models
        $CopiedCount = 0
        foreach ($ModelName in $EssentialModels) {
            $SourcePath = Join-Path $PreDownloadedModelsDir "$ModelName.pt"
            $DestPath = Join-Path $ModelsDir "$ModelName.pt"
            
            if (Test-Path $SourcePath) {
                if (-not (Test-Path $DestPath)) {
                    Copy-Item $SourcePath $DestPath
                    $FileSize = [math]::Round((Get-Item $DestPath).Length / 1MB, 1)
                    Write-Status "Copied $ModelName model ($FileSize MB)" "[COPY]"
                    $CopiedCount++
                } else {
                    $FileSize = [math]::Round((Get-Item $DestPath).Length / 1MB, 1)
                    Write-Status "$ModelName model already exists ($FileSize MB)" "[SKIP]"
                }
            }
        }
        
        if ($CopiedCount -gt 0) {
            Write-Status "Copied $CopiedCount pre-downloaded models" "[MODELS-COPIED]"
        }
    }
    
    # Check for existing models after copy
    $ExistingModels = @()
    foreach ($ModelName in $EssentialModels) {
        $ModelPath = Join-Path $ModelsDir "$ModelName.pt"
        if (Test-Path $ModelPath) {
            $FileSize = (Get-Item $ModelPath).Length / 1MB
            $ExistingModels += @{ name = $ModelName; size = $FileSize }
        }
    }
    
    if ($ExistingModels.Count -gt 0) {
        Write-Status "Available models:" "[READY]"
        foreach ($Model in $ExistingModels) {
            Write-Status "  - $($Model.name): $(([math]::Round($Model.size, 1))) MB" "[MODEL]"
        }
    }
    
    if ($SkipDownloads -or (Test-Path $PreDownloadedModelsDir)) {
        Write-Status "Using pre-downloaded models (no internet required!)" "[OFFLINE]"
        if ($ExistingModels.Count -eq 0) {
            Write-Status "No models found - see docs/MANUAL_MODEL_DOWNLOAD.md for instructions" "[INFO]"
        }
    } else {
        $ModelSetName = if ($ModelSet -eq "all") { "all Whisper" } else { "essential (tiny, base, small)" }
        Write-Status "Downloading $ModelSetName models..." "[DOWNLOAD]"
        
        $TotalSize = 0
        foreach ($Model in $ModelsToDownload) {
            $ModelPath = Join-Path $ModelsDir "$($Model.name).pt"
            
            if (Test-Path $ModelPath) {
                Write-Status "Model $($Model.name) already exists, skipping..." "[SKIP]"
                continue
            }
            
            Write-Status "Downloading Whisper $($Model.name) model ($($Model.size))..." "[DL-$($Model.name.ToUpper())]"
            
            try {
                # Use fast Invoke-WebRequest instead of slow Download-File function
                Invoke-WebRequest -Uri $Model.url -OutFile $ModelPath
                $FileSize = (Get-Item $ModelPath).Length / 1MB
                $TotalSize += $FileSize
                Write-Status "Downloaded $($Model.name) model ($(([math]::Round($FileSize, 1))) MB)" "[DONE]"
            }
            catch {
                Write-ErrorMsg "Failed to download $($Model.name) model: $($_.Exception.Message)"
                Write-Status "You can manually download this model - see docs/MANUAL_MODEL_DOWNLOAD.md" "[INFO]"
                # Continue with other models even if one fails
            }
        }
        
        if ($TotalSize -gt 0) {
            Write-Status "Downloaded models totaling $(([math]::Round($TotalSize, 1))) MB" "[MODELS-DONE]"
        }
    }
    
    # Always create/update model manifest
    $ManifestContent = @"
{
  "models": [
    { "name": "tiny", "file": "tiny.pt", "description": "Fastest, basic accuracy (~39MB) - See manual download guide if missing" },
    { "name": "base", "file": "base.pt", "description": "Good balance of speed/accuracy (~74MB) - See manual download guide if missing" },
    { "name": "small", "file": "small.pt", "description": "Better accuracy, slower (~244MB) - See manual download guide if missing" },
    { "name": "medium", "file": "medium.pt", "description": "High accuracy, much slower (~769MB) - See manual download guide if missing" },
    { "name": "large", "file": "large-v2.pt", "description": "Best accuracy, very slow (~1550MB) - See manual download guide if missing" }
  ],
  "default": "tiny",
  "offline": true,
  "manual_download_guide": "docs/MANUAL_MODEL_DOWNLOAD.md"
}
"@
    
    $ManifestPath = Join-Path $ModelsDir "manifest.json"
    $Utf8NoBomEncoding = New-Object System.Text.UTF8Encoding $False
    [System.IO.File]::WriteAllText($ManifestPath, $ManifestContent, $Utf8NoBomEncoding)
    
    Write-Status "Created/updated model manifest" "[MANIFEST]"
}

function Cleanup-TempFiles {
    Write-Status "Cleaning up temporary files..." "[CLEANUP]"
    
    if (Test-Path $TEMP_DIR) {
        Remove-Item $TEMP_DIR -Recurse -Force
    }
    
    Write-Status "Cleanup completed" "[DONE]"
}

# Main script
try {
    Write-Host "[START] MVP-Echo Python Embedded Distribution Preparation" -ForegroundColor Cyan
    Write-Host "===============================================" -ForegroundColor Cyan
    Write-Host ""
    
    if ($Clean) {
        Write-Status "Cleaning up existing files..." "[CLEAN]"
        if (Test-Path $PYTHON_EMBEDDED_DIR) {
            Remove-Item $PYTHON_EMBEDDED_DIR -Recurse -Force
        }
        if (Test-Path $TEMP_DIR) {
            Remove-Item $TEMP_DIR -Recurse -Force
        }
        Write-Status "Cleanup completed" "[DONE]"
        return
    }
    
    # Create directories
    if (-not (Test-Path $TEMP_DIR)) {
        New-Item -ItemType Directory -Path $TEMP_DIR -Force | Out-Null
    }
    
    if (Test-Path $PYTHON_EMBEDDED_DIR) {
        Write-Status "Removing existing Python embedded directory..." "[CLEAN]"
        Remove-Item $PYTHON_EMBEDDED_DIR -Recurse -Force
    }
    
    # Download Python embedded if needed
    if (-not $SkipDownload -and -not (Test-Path $PYTHON_ZIP)) {
        Download-File $PYTHON_EMBEDDED_URL $PYTHON_ZIP
    }
    elseif (Test-Path $PYTHON_ZIP) {
        Write-Status "Using existing Python embedded ZIP file" "[FOUND]"
    }
    else {
        Write-ErrorMsg "Python ZIP file not found and download was skipped"
        throw "Missing Python ZIP file"
    }
    
    # Extract Python
    Extract-PythonZip $PYTHON_ZIP $PYTHON_EMBEDDED_DIR
    
    # Find Python executable
    $PythonExe = Join-Path $PYTHON_EMBEDDED_DIR "python.exe"
    
    if (-not (Test-Path $PythonExe)) {
        throw "Python executable not found after extraction"
    }
    
    # Create portable configuration FIRST (before installing packages)
    Create-PortableConfig $PYTHON_EMBEDDED_DIR
    
    # Install required packages
    Install-PythonPackages $PythonExe
    
    # Setup Whisper models (download or use existing)
    $ModelSet = if ($AllModels) { "all" } else { "essential" }
    Setup-WhisperModels $PYTHON_EMBEDDED_DIR $SkipModels $ModelSet
    
    # Clean up
    Cleanup-TempFiles
    
    # Success message
    $Size = Get-FolderSize $PYTHON_EMBEDDED_DIR
    
    Write-Host ""
    Write-Host "[SUCCESS] Python embedded distribution prepared!" -ForegroundColor Green
    Write-Host "[INFO] Location: $PYTHON_EMBEDDED_DIR" -ForegroundColor Green
    Write-Host "[INFO] Size: $Size MB" -ForegroundColor Green
    Write-Host ""
    
    # Check for existing models
    $ModelsDir = Join-Path $PYTHON_EMBEDDED_DIR "models"
    $ModelCount = 0
    if (Test-Path $ModelsDir) {
        $ModelCount = (Get-ChildItem $ModelsDir -Filter "*.pt").Count
    }
    
    if ($ModelCount -gt 0) {
        Write-Host "Found $ModelCount Whisper model(s) for offline use:" -ForegroundColor Green
        Get-ChildItem $ModelsDir -Filter "*.pt" | ForEach-Object {
            $SizeMB = [math]::Round($_.Length / 1MB, 1)
            Write-Host "  - $($_.BaseName): $SizeMB MB" -ForegroundColor Green
        }
        Write-Host ""
        Write-Host "Next steps:" -ForegroundColor Cyan
        Write-Host "1. Run 'npm run pack:portable:manual' to build the portable app"
        Write-Host "2. Your app will be COMPLETELY OFFLINE - no internet required!"
    } else {
        Write-Host "No Whisper models found." -ForegroundColor Yellow
        Write-Host ""
        Write-Host "FAST SETUP - Manual Download (Recommended):" -ForegroundColor Cyan
        Write-Host "1. See docs/QUICK_START_MANUAL.md for fast manual setup"
        Write-Host "2. Download models manually (much faster than automated)"
        Write-Host "3. Run 'npm run pack:portable:manual' when ready"
        Write-Host ""
        Write-Host "OR - Automated Download (Slower):" -ForegroundColor Yellow
        Write-Host "1. Run 'npm run prepare:python:ps' (without -SkipModels flag)"
        Write-Host "2. This will download all models automatically (slower)"
    }
    Write-Host ""
}
catch {
    Write-ErrorMsg "Failed to prepare Python embedded distribution: $($_.Exception.Message)"
    exit 1
}