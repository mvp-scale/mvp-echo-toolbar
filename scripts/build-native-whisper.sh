#!/bin/bash
# MVP-Echo: Build Native Whisper Integration Script
# Builds standalone whisper and integrates it into the main app

set -e  # Exit on any error

# Configuration
STANDALONE_DIR="standalone-whisper"
OUTPUT_DIR="whisper-bin"
EXE_NAME="whisper-standalone.exe"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
GRAY='\033[0;37m'
NC='\033[0m'

echo -e "\n${CYAN}🎯 MVP-Echo: Building Native Whisper Engine${NC}"
echo -e "${CYAN}===========================================${NC}\n"

# Parse arguments
CLEAN=false
TEST=false

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
        --help)
            echo "Usage: $0 [--clean] [--test] [--help]"
            echo "  --clean    Clean all build artifacts"
            echo "  --test     Test executable after building"
            exit 0
            ;;
    esac
done

# Clean mode
if [ "$CLEAN" = true ]; then
    echo -e "${YELLOW}🧹 Cleaning native whisper build...${NC}"
    
    # Clean standalone build
    if [ -d "$STANDALONE_DIR" ]; then
        cd "$STANDALONE_DIR"
        ./build.sh --clean
        cd ..
    fi
    
    # Clean integration
    if [ -d "$OUTPUT_DIR" ]; then
        rm -f "$OUTPUT_DIR/$EXE_NAME"
        echo -e "${GRAY}   ✓ Removed $OUTPUT_DIR/$EXE_NAME${NC}"
    fi
    
    echo -e "${GREEN}✅ Clean complete!${NC}"
    exit 0
fi

# Check standalone directory
if [ ! -d "$STANDALONE_DIR" ]; then
    echo -e "${RED}❌ Standalone whisper directory not found: $STANDALONE_DIR${NC}"
    echo -e "${GRAY}   This should contain the isolated build environment.${NC}"
    exit 1
fi

# Stage 1: Build standalone executable
echo -e "${YELLOW}🏗️ Stage 1: Building standalone executable...${NC}"
echo -e "${GRAY}   Working in: $STANDALONE_DIR${NC}"

cd "$STANDALONE_DIR"

# Build the standalone executable
BUILD_ARGS=()
if [ "$TEST" = true ]; then
    BUILD_ARGS+=(--test)
fi

./build.sh "${BUILD_ARGS[@]}"

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Standalone build failed${NC}"
    exit 1
fi

# Check if executable was created
STANDALONE_PATH="dist/$EXE_NAME"
if [ ! -f "$STANDALONE_PATH" ]; then
    echo -e "${RED}❌ Executable not found: $STANDALONE_PATH${NC}"
    exit 1
fi

SIZE_BYTES=$(stat -c%s "$STANDALONE_PATH")
SIZE_MB=$(echo "scale=1; $SIZE_BYTES / 1048576" | bc)
echo -e "${GREEN}✅ Stage 1 complete: ${SIZE_MB} MB executable ready${NC}"

# Go back to main directory
cd ..

# Stage 2: Integrate into main app
echo -e "\n${YELLOW}🔗 Stage 2: Integrating into MVP-Echo...${NC}"

# Create whisper-bin directory
if [ ! -d "$OUTPUT_DIR" ]; then
    mkdir -p "$OUTPUT_DIR"
    echo -e "${GRAY}   ✓ Created $OUTPUT_DIR directory${NC}"
fi

# Copy executable
SOURCE_PATH="$STANDALONE_DIR/dist/$EXE_NAME"
DEST_PATH="$OUTPUT_DIR/$EXE_NAME"

cp "$SOURCE_PATH" "$DEST_PATH"

if [ $? -eq 0 ] && [ -f "$DEST_PATH" ]; then
    echo -e "${GRAY}   ✓ Copied $EXE_NAME to $OUTPUT_DIR${NC}"
    
    # Verify copy
    DEST_SIZE_BYTES=$(stat -c%s "$DEST_PATH")
    DEST_SIZE_MB=$(echo "scale=1; $DEST_SIZE_BYTES / 1048576" | bc)
    echo -e "${GRAY}   ✓ Verified: ${DEST_SIZE_MB} MB${NC}"
else
    echo -e "${RED}❌ Failed to copy executable${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Stage 2 complete: Native engine integrated${NC}"

# Final verification
echo -e "\n${YELLOW}🧪 Final verification...${NC}"
if ./"$DEST_PATH" --version > /dev/null 2>&1; then
    echo -e "${GREEN}   ✓ Executable test passed${NC}"
else
    echo -e "${YELLOW}   ⚠️ Executable test failed${NC}"
fi

echo -e "\n${GREEN}🎉 Native Whisper Engine Ready!${NC}"
echo -e "${GREEN}===============================${NC}"

echo -e "\n${CYAN}📁 Files created:${NC}"
echo -e "${GRAY}   • $DEST_PATH (native executable)${NC}"
echo -e "${GRAY}   • Ready for electron-builder packaging${NC}"

echo -e "\n${CYAN}🚀 Next steps:${NC}"  
echo -e "${GRAY}   npm run pack    # Package MVP-Echo with native engine${NC}"
echo -e "${GRAY}   npm run dist    # Create installer with native engine${NC}"

echo -e "\n${YELLOW}✨ This gives you:${NC}"
echo -e "${GRAY}   • Native Faster-Whisper (no Python required)${NC}"
echo -e "${GRAY}   • GPU acceleration out-of-the-box${NC}"
echo -e "${GRAY}   • Same technology as Python upgrade path${NC}"
echo -e "${GRAY}   • Models auto-download on first use${NC}"
echo -e "${GRAY}   • Complete offline operation after setup${NC}"