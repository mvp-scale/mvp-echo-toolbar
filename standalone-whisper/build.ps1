# Build MVP-Echo Standalone Whisper Executable
# Creates a single .exe file with no Python dependencies
param(
    [switch]$Clean = $false,
    [switch]$Test = $false,
    [switch]$Verbose = $false
)

$ErrorActionPreference = "Stop"

# Configuration
$exeName = "whisper-standalone"
$scriptName = "whisper-cli.py"
$outputDir = "dist"
$workDir = "build"

Write-Host "`n🏗️  MVP-Echo Standalone Whisper Builder" -ForegroundColor Cyan
Write-Host "======================================`n" -ForegroundColor Cyan

# Clean mode
if ($Clean) {
    Write-Host "🧹 Cleaning build artifacts..." -ForegroundColor Yellow
    @($workDir, $outputDir, "*.spec") | ForEach-Object {
        if (Test-Path $_) {
            Remove-Item -Path $_ -Recurse -Force
            Write-Host "   ✓ Removed $_" -ForegroundColor Gray
        }
    }
    Write-Host "✅ Clean complete!" -ForegroundColor Green
    exit 0
}

# Check Python
try {
    $pythonVersion = python --version 2>&1
    Write-Host "✓ Python: $pythonVersion" -ForegroundColor Green
} catch {
    Write-Host "❌ Python not found. Please install Python 3.8+" -ForegroundColor Red
    exit 1
}

# Check/Install dependencies
Write-Host "`n📦 Installing dependencies..." -ForegroundColor Yellow
pip install -r requirements.txt --quiet
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Failed to install dependencies" -ForegroundColor Red
    exit 1
}
Write-Host "✓ Dependencies installed" -ForegroundColor Green

# Create version info
$versionInfo = @"
VSVersionInfo(
  ffi=FixedFileInfo(
    filevers=(1,0,0,0),
    prodvers=(1,0,0,0),
    mask=0x3f,
    flags=0x0,
    OS=0x4,
    fileType=0x1,
    subtype=0x0,
    date=(0, 0)
    ),
  kids=[
    StringFileInfo([
      StringTable(u'040904B0', [
        StringStruct(u'CompanyName', u'MVP-Echo'),
        StringStruct(u'FileDescription', u'MVP-Echo Standalone Whisper'),
        StringStruct(u'FileVersion', u'1.0.0.0'),
        StringStruct(u'InternalName', u'whisper-standalone'),
        StringStruct(u'LegalCopyright', u'Copyright 2024 MVP-Echo'),
        StringStruct(u'OriginalFilename', u'whisper-standalone.exe'),
        StringStruct(u'ProductName', u'MVP-Echo Standalone Whisper'),
        StringStruct(u'ProductVersion', u'1.0.0.0')
      ])
    ]), 
    VarFileInfo([VarStruct(u'Translation', [1033, 1200])])
  ]
)
"@

Set-Content -Path "version_info.txt" -Value $versionInfo -Encoding UTF8

# Build with PyInstaller
Write-Host "`n🔨 Building executable..." -ForegroundColor Yellow

$pyinstallerArgs = @(
    "--onefile",                    # Single executable
    "--name=$exeName",              # Output name
    "--distpath=$outputDir",        # Output directory
    "--workpath=$workDir",          # Work directory  
    "--specpath=$workDir",          # Spec file location
    "--clean",                      # Clean cache
    "--noconfirm",                  # Overwrite without confirmation
    "--console",                    # Console app
    
    # Hidden imports (critical for bundling)
    "--hidden-import=faster_whisper",
    "--hidden-import=faster_whisper.transcribe",
    "--hidden-import=faster_whisper.vad",
    "--hidden-import=torch",
    "--hidden-import=ctranslate2",
    "--hidden-import=tokenizers",
    "--hidden-import=huggingface_hub",
    "--hidden-import=numpy",
    "--hidden-import=onnxruntime",
    
    # Version info
    "--version-file=version_info.txt",
    
    # Optimize
    "--optimize=2"
)

if ($Verbose) {
    $pyinstallerArgs += "--log-level=DEBUG"
} else {
    $pyinstallerArgs += "--log-level=WARN"
}

# Run PyInstaller
$command = "pyinstaller " + ($pyinstallerArgs -join " ") + " `"$scriptName`""
Write-Host "Command: $command" -ForegroundColor DarkGray

try {
    Invoke-Expression $command
    
    $exePath = "$outputDir\$exeName.exe"
    if ($LASTEXITCODE -eq 0 -and (Test-Path $exePath)) {
        Write-Host "✅ Build successful!" -ForegroundColor Green
        
        # Get file info
        $fileInfo = Get-Item $exePath
        $sizeMB = [math]::Round($fileInfo.Length / 1MB, 1)
        
        Write-Host "`n📁 Executable created:" -ForegroundColor Cyan
        Write-Host "   Path: $exePath" -ForegroundColor Gray
        Write-Host "   Size: $sizeMB MB" -ForegroundColor Gray
        Write-Host "   Modified: $($fileInfo.LastWriteTime)" -ForegroundColor Gray
        
        # Test the executable
        if ($Test) {
            Write-Host "`n🧪 Testing executable..." -ForegroundColor Yellow
            try {
                $testOutput = & $exePath --version 2>&1
                if ($LASTEXITCODE -eq 0) {
                    Write-Host "   ✓ Version test passed: $testOutput" -ForegroundColor Green
                } else {
                    Write-Host "   ⚠️ Version test failed (exit code $LASTEXITCODE)" -ForegroundColor Yellow
                }
            } catch {
                Write-Host "   ❌ Executable test failed: $_" -ForegroundColor Red
            }
        }
        
    } else {
        Write-Host "❌ Build failed - executable not created" -ForegroundColor Red
        exit 1
    }
    
} catch {
    Write-Host "❌ PyInstaller failed: $_" -ForegroundColor Red
    exit 1
} finally {
    # Cleanup
    Remove-Item -Path "version_info.txt" -Force -ErrorAction SilentlyContinue
}

Write-Host "`n🎉 MVP-Echo Standalone Whisper Ready!" -ForegroundColor Green
Write-Host "====================================" -ForegroundColor Green

Write-Host "`n✨ Features:" -ForegroundColor Cyan
Write-Host "   • No Python installation required" -ForegroundColor Gray
Write-Host "   • Automatic GPU detection and usage" -ForegroundColor Gray  
Write-Host "   • Voice Activity Detection (VAD)" -ForegroundColor Gray
Write-Host "   • Models auto-download on first use" -ForegroundColor Gray
Write-Host "   • JSON and text output formats" -ForegroundColor Gray
Write-Host "   • Same Faster-Whisper technology as full Python" -ForegroundColor Gray

Write-Host "`n📖 Usage examples:" -ForegroundColor Cyan
Write-Host "   $exePath.exe audio.wav" -ForegroundColor Gray
Write-Host "   $exePath.exe audio.mp3 --model base --language en" -ForegroundColor Gray
Write-Host "   $exePath.exe audio.wav --gpu --json" -ForegroundColor Gray

Write-Host "`n🎯 Next: Copy to MVP-Echo project" -ForegroundColor Yellow
Write-Host "   copy $exePath ..\mvp-echo\whisper-bin\" -ForegroundColor Gray