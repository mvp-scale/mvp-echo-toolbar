# Build our own trusted Faster-Whisper standalone executable
# Uses PyInstaller to bundle Python + Faster-Whisper into single .exe
param(
    [switch]$Clean = $false,
    [switch]$Verbose = $false
)

$ErrorActionPreference = "Stop"

# Paths
$buildDir = "build-standalone"
$distDir = "whisper-bin"
$scriptPath = "scripts\whisper-standalone.py"
$exeName = "whisper-standalone.exe"

# Clean mode
if ($Clean) {
    Write-Host "🧹 Cleaning build artifacts..." -ForegroundColor Yellow
    @($buildDir, $distDir, "*.spec") | ForEach-Object {
        if (Test-Path $_) {
            Remove-Item -Path $_ -Recurse -Force
            Write-Host "   ✓ Removed $_" -ForegroundColor Gray
        }
    }
    Write-Host "✅ Clean complete!" -ForegroundColor Green
    exit 0
}

Write-Host "`n🏗️  Building MVP-Echo Standalone Whisper" -ForegroundColor Cyan
Write-Host "=====================================`n" -ForegroundColor Cyan

# Check if Python is available
try {
    $pythonVersion = python --version 2>&1
    Write-Host "✓ Python found: $pythonVersion" -ForegroundColor Green
} catch {
    Write-Host "❌ Python not found. Please install Python 3.8+ first." -ForegroundColor Red
    exit 1
}

# Check required packages
Write-Host "`n📦 Checking dependencies..." -ForegroundColor Yellow

$requiredPackages = @(
    "faster-whisper",
    "torch", 
    "pyinstaller"
)

foreach ($package in $requiredPackages) {
    try {
        $result = pip show $package 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "   ✓ $package installed" -ForegroundColor Green
        } else {
            Write-Host "   ❌ $package not found, installing..." -ForegroundColor Yellow
            pip install $package
            if ($LASTEXITCODE -ne 0) {
                Write-Host "   ❌ Failed to install $package" -ForegroundColor Red
                exit 1
            }
            Write-Host "   ✓ $package installed" -ForegroundColor Green
        }
    } catch {
        Write-Host "   ❌ Error checking $package" -ForegroundColor Red
        exit 1
    }
}

# Create output directory
if (!(Test-Path $distDir)) {
    New-Item -ItemType Directory -Path $distDir | Out-Null
    Write-Host "✓ Created output directory: $distDir" -ForegroundColor Green
}

# Build with PyInstaller
Write-Host "`n🔨 Building standalone executable..." -ForegroundColor Yellow

$pyinstallerArgs = @(
    "--onefile",                    # Single executable
    "--name=$($exeName -replace '\.exe$', '')",  # Output name
    "--distpath=$distDir",          # Output directory
    "--workpath=$buildDir",         # Work directory
    "--specpath=$buildDir",         # Spec file location
    "--clean",                      # Clean cache
    "--noconfirm",                  # Overwrite without confirmation
    
    # Hidden imports (ensure all deps are included)
    "--hidden-import=faster_whisper",
    "--hidden-import=torch",
    "--hidden-import=ctranslate2",
    "--hidden-import=tokenizers",
    "--hidden-import=huggingface_hub",
    "--hidden-import=numpy",
    
    # Console app (not windowed)
    "--console",
    
    # Add icon if available
    # "--icon=icon.ico",
    
    # Version info
    "--version-file=version_info.txt"
)

if ($Verbose) {
    $pyinstallerArgs += "--log-level=DEBUG"
}

# Create version info file
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
    StringFileInfo(
      [
      StringTable(
        u'040904B0',
        [StringStruct(u'CompanyName', u'MVP-Echo'),
        StringStruct(u'FileDescription', u'MVP-Echo Standalone Whisper'),
        StringStruct(u'FileVersion', u'1.0.0.0'),
        StringStruct(u'InternalName', u'whisper-standalone'),
        StringStruct(u'LegalCopyright', u'Copyright 2024 MVP-Echo'),
        StringStruct(u'OriginalFilename', u'whisper-standalone.exe'),
        StringStruct(u'ProductName', u'MVP-Echo Standalone Whisper'),
        StringStruct(u'ProductVersion', u'1.0.0.0')])
      ]), 
    VarFileInfo([VarStruct(u'Translation', [1033, 1200])])
  ]
)
"@

Set-Content -Path "version_info.txt" -Value $versionInfo -Encoding UTF8

# Run PyInstaller
Write-Host "Running PyInstaller..." -ForegroundColor Gray
$pyinstallerCmd = "pyinstaller " + ($pyinstallerArgs -join " ") + " `"$scriptPath`""
Write-Host $pyinstallerCmd -ForegroundColor DarkGray

try {
    Invoke-Expression $pyinstallerCmd
    
    if ($LASTEXITCODE -eq 0 -and (Test-Path "$distDir\$exeName")) {
        Write-Host "✅ Build successful!" -ForegroundColor Green
        
        # Get file size
        $fileSize = (Get-Item "$distDir\$exeName").Length / 1MB
        Write-Host "   📁 Executable: $distDir\$exeName" -ForegroundColor Gray
        Write-Host "   📏 Size: $([math]::Round($fileSize, 1)) MB" -ForegroundColor Gray
        
        # Test the executable
        Write-Host "`n🧪 Testing executable..." -ForegroundColor Yellow
        try {
            $testOutput = & "$distDir\$exeName" --version 2>&1
            if ($LASTEXITCODE -eq 0) {
                Write-Host "   ✓ Executable test passed: $testOutput" -ForegroundColor Green
            } else {
                Write-Host "   ⚠️ Executable test warning (exit code $LASTEXITCODE)" -ForegroundColor Yellow
            }
        } catch {
            Write-Host "   ❌ Executable test failed: $_" -ForegroundColor Red
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
Write-Host "===================================" -ForegroundColor Green

Write-Host "`nUsage:" -ForegroundColor Cyan
Write-Host "  $distDir\$exeName audio.wav" -ForegroundColor Gray
Write-Host "  $distDir\$exeName audio.mp3 --model base --language en" -ForegroundColor Gray
Write-Host "  $distDir\$exeName audio.wav --gpu --output-json result.json" -ForegroundColor Gray

Write-Host "`nFeatures:" -ForegroundColor Cyan
Write-Host "  ✓ No Python installation required" -ForegroundColor Gray
Write-Host "  ✓ Automatic GPU detection and usage" -ForegroundColor Gray  
Write-Host "  ✓ Voice Activity Detection (VAD)" -ForegroundColor Gray
Write-Host "  ✓ Multiple model sizes (tiny, base, small, medium, large)" -ForegroundColor Gray
Write-Host "  ✓ Automatic language detection" -ForegroundColor Gray
Write-Host "  ✓ JSON output support" -ForegroundColor Gray
Write-Host "  ✓ Same technology as Python upgrade path" -ForegroundColor Gray

Write-Host "`n📁 Files created:" -ForegroundColor Yellow
Write-Host "  • $distDir\$exeName (standalone executable)" -ForegroundColor Gray
Write-Host "  • Models will auto-download to .\models\ on first use" -ForegroundColor Gray