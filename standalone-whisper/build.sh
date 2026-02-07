#!/bin/bash
# Build MVP-Echo Standalone Whisper Executable
# Creates a single .exe file with no Python dependencies

set -e  # Exit on any error

# Configuration
EXE_NAME="whisper-standalone"
SCRIPT_NAME="whisper-cli.py"
OUTPUT_DIR="dist"
WORK_DIR="build"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
GRAY='\033[0;37m'
NC='\033[0m' # No Color

echo -e "\n${CYAN}🏗️  MVP-Echo Standalone Whisper Builder${NC}"
echo -e "${CYAN}======================================${NC}\n"

# Parse arguments
CLEAN=false
TEST=false
VERBOSE=false

for arg in "$@"; do
    case $arg in
        --clean)
            CLEAN=true
            shift
            ;;
        --test)
            TEST=true
            shift
            ;;
        --verbose)
            VERBOSE=true
            shift
            ;;
        --help)
            echo "Usage: $0 [--clean] [--test] [--verbose] [--help]"
            echo "  --clean    Clean build artifacts"
            echo "  --test     Test executable after building"
            echo "  --verbose  Show detailed build output"
            exit 0
            ;;
    esac
done

# Clean mode
if [ "$CLEAN" = true ]; then
    echo -e "${YELLOW}🧹 Cleaning build artifacts...${NC}"
    rm -rf "$WORK_DIR" "$OUTPUT_DIR" *.spec
    echo -e "${GREEN}✅ Clean complete!${NC}"
    exit 0
fi

# Check Python
echo -e "${YELLOW}🐍 Checking Python...${NC}"
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}❌ Python3 not found. Please install Python 3.8+${NC}"
    exit 1
fi

PYTHON_VERSION=$(python3 --version)
echo -e "${GREEN}✓ Python: $PYTHON_VERSION${NC}"

# Setup virtual environment and install dependencies
echo -e "\n${YELLOW}📦 Setting up virtual environment...${NC}"

# Create virtual environment if it doesn't exist
if [ ! -d "venv" ]; then
    echo -e "${GRAY}   Creating virtual environment...${NC}"
    python3 -m venv venv
fi

# Activate virtual environment
echo -e "${GRAY}   Activating virtual environment...${NC}"
source venv/bin/activate

# Install dependencies
echo -e "${GRAY}   Installing dependencies...${NC}"
if [ "$VERBOSE" = true ]; then
    pip install -r requirements.txt
else
    pip install -r requirements.txt --quiet
fi

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Failed to install dependencies${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Virtual environment ready${NC}"

# Create version info file
cat > version_info.py << 'EOF'
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
EOF

# Build with PyInstaller
echo -e "\n${YELLOW}🔨 Building executable...${NC}"

# PyInstaller arguments
PYINSTALLER_ARGS=(
    "--onefile"                     # Single executable
    "--name=$EXE_NAME"              # Output name
    "--distpath=$OUTPUT_DIR"        # Output directory
    "--workpath=$WORK_DIR"          # Work directory  
    "--specpath=$WORK_DIR"          # Spec file location
    "--clean"                       # Clean cache
    "--noconfirm"                   # Overwrite without confirmation
    "--console"                     # Console app
    
    # Hidden imports (critical for bundling)
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
    "--version-file=version_info.py"
    
    # Optimize
    "--optimize=2"
)

if [ "$VERBOSE" = true ]; then
    PYINSTALLER_ARGS+=("--log-level=DEBUG")
else
    PYINSTALLER_ARGS+=("--log-level=WARN")
fi

# Run PyInstaller (using virtual environment)
echo -e "${GRAY}Running: pyinstaller ${PYINSTALLER_ARGS[*]} $SCRIPT_NAME${NC}"

# Make sure we're still in the virtual environment
if [ -z "$VIRTUAL_ENV" ]; then
    echo -e "${YELLOW}   Re-activating virtual environment...${NC}"
    source venv/bin/activate
fi

python -m PyInstaller "${PYINSTALLER_ARGS[@]}" "$SCRIPT_NAME"

# Check if build succeeded
EXE_PATH="$OUTPUT_DIR/$EXE_NAME.exe"
if [ $? -eq 0 ] && [ -f "$EXE_PATH" ]; then
    echo -e "${GREEN}✅ Build successful!${NC}"
    
    # Get file info
    SIZE_BYTES=$(stat -c%s "$EXE_PATH")
    SIZE_MB=$(echo "scale=1; $SIZE_BYTES / 1048576" | bc)
    
    echo -e "\n${CYAN}📁 Executable created:${NC}"
    echo -e "${GRAY}   Path: $EXE_PATH${NC}"
    echo -e "${GRAY}   Size: ${SIZE_MB} MB${NC}"
    echo -e "${GRAY}   Modified: $(stat -c%y "$EXE_PATH")${NC}"
    
    # Test the executable
    if [ "$TEST" = true ]; then
        echo -e "\n${YELLOW}🧪 Testing executable...${NC}"
        if ./"$EXE_PATH" --version; then
            echo -e "${GREEN}   ✓ Executable test passed${NC}"
        else
            echo -e "${YELLOW}   ⚠️ Executable test failed${NC}"
        fi
    fi
    
else
    echo -e "${RED}❌ Build failed - executable not created${NC}"
    exit 1
fi

# Cleanup
rm -f version_info.py

echo -e "\n${GREEN}🎉 MVP-Echo Standalone Whisper Ready!${NC}"
echo -e "${GREEN}====================================${NC}"

echo -e "\n${CYAN}✨ Features:${NC}"
echo -e "${GRAY}   • No Python installation required${NC}"
echo -e "${GRAY}   • Automatic GPU detection and usage${NC}"
echo -e "${GRAY}   • Voice Activity Detection (VAD)${NC}"
echo -e "${GRAY}   • Models auto-download on first use${NC}"
echo -e "${GRAY}   • JSON and text output formats${NC}"
echo -e "${GRAY}   • Same Faster-Whisper technology as full Python${NC}"

echo -e "\n${CYAN}📖 Usage examples:${NC}"
echo -e "${GRAY}   ./$EXE_PATH audio.wav${NC}"
echo -e "${GRAY}   ./$EXE_PATH audio.mp3 --model base --language en${NC}"
echo -e "${GRAY}   ./$EXE_PATH audio.wav --gpu --json${NC}"

echo -e "\n${YELLOW}🎯 Next: Copy to MVP-Echo project${NC}"
echo -e "${GRAY}   cp $EXE_PATH ../whisper-bin/${NC}"