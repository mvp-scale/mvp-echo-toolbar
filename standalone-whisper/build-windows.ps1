# Windows container build script for whisper-standalone.exe
param(
    [switch]$Verbose = $false
)

$ErrorActionPreference = "Stop"

# Configuration
$exeName = "whisper-standalone"
$scriptName = "whisper-cli.py"
$outputDir = "dist"
$workDir = "build"

Write-Host "🏗️  Building whisper-standalone.exe in Windows container" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

# Clean previous builds
if (Test-Path $outputDir) { Remove-Item -Path $outputDir -Recurse -Force }
if (Test-Path $workDir) { Remove-Item -Path $workDir -Recurse -Force }

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

# PyInstaller arguments for Windows build
$pyinstallerArgs = @(
    "--onefile"
    "--name=$exeName"
    "--distpath=$outputDir"
    "--workpath=$workDir"
    "--specpath=$workDir"
    "--clean"
    "--noconfirm"
    "--console"
    
    # Hidden imports
    "--hidden-import=faster_whisper"
    "--hidden-import=faster_whisper.transcribe"
    "--hidden-import=faster_whisper.vad"
    "--hidden-import=torch"
    "--hidden-import=ctranslate2"
    "--hidden-import=tokenizers"
    "--hidden-import=huggingface_hub"
    "--hidden-import=numpy"
    "--hidden-import=onnxruntime"
    
    # Version info
    "--version-file=version_info.txt"
    
    # Optimize
    "--optimize=2"
)

if ($Verbose) {
    $pyinstallerArgs += "--log-level=DEBUG"
} else {
    $pyinstallerArgs += "--log-level=WARN"
}

Write-Host "🔨 Running PyInstaller..." -ForegroundColor Yellow

# Run PyInstaller
$command = "python -m PyInstaller " + ($pyinstallerArgs -join " ") + " `"$scriptName`""
Write-Host "Command: $command" -ForegroundColor DarkGray

Invoke-Expression $command

# Check result
$exePath = "$outputDir\$exeName.exe"
if ($LASTEXITCODE -eq 0 -and (Test-Path $exePath)) {
    Write-Host "✅ Build successful!" -ForegroundColor Green
    
    $fileInfo = Get-Item $exePath
    $sizeMB = [math]::Round($fileInfo.Length / 1MB, 1)
    
    Write-Host "`n📁 Windows executable created:" -ForegroundColor Cyan
    Write-Host "   Path: $exePath" -ForegroundColor Gray
    Write-Host "   Size: $sizeMB MB" -ForegroundColor Gray
    Write-Host "   Modified: $($fileInfo.LastWriteTime)" -ForegroundColor Gray
    
} else {
    Write-Host "❌ Build failed" -ForegroundColor Red
    exit 1
}

# Cleanup
Remove-Item -Path "version_info.txt" -Force -ErrorAction SilentlyContinue

Write-Host "`n🎉 whisper-standalone.exe ready for Windows!" -ForegroundColor Green