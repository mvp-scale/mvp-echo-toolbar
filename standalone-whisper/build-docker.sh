#!/bin/bash
# Build Windows executable using Docker Windows container from Ubuntu
# This avoids Wine and gives you a real Windows build environment

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
GRAY='\033[0;37m'
NC='\033[0m'

echo -e "\n${CYAN}🐳 Docker Windows Build for whisper-standalone.exe${NC}"
echo -e "${CYAN}=================================================${NC}\n"

# Check Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker not found. Please install Docker Desktop${NC}"
    exit 1
fi

# Check if Docker supports Windows containers
echo -e "${YELLOW}📋 Checking Docker configuration...${NC}"
if ! docker system info | grep -q "OSType.*windows" 2>/dev/null; then
    echo -e "${YELLOW}⚠️  Docker is not configured for Windows containers${NC}"
    echo -e "${GRAY}   This will use Linux containers with Windows base images${NC}"
    echo -e "${GRAY}   Performance may be slower but should work${NC}"
fi

# Build Docker image
echo -e "\n${YELLOW}🔨 Building Docker image...${NC}"
docker build -t whisper-windows-builder -f Dockerfile.windows .

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Failed to build Docker image${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Docker image built successfully${NC}"

# Create output directory if it doesn't exist
mkdir -p dist

# Run container to build executable
echo -e "\n${YELLOW}🏗️  Building Windows executable...${NC}"
echo -e "${GRAY}   This may take 5-10 minutes on first run...${NC}"

docker run --rm \
    -v "$(pwd):/host" \
    whisper-windows-builder \
    powershell -ExecutionPolicy Bypass -Command "
        # Build the executable
        ./build-windows.ps1
        
        # Copy result to host
        if (Test-Path 'dist\\whisper-standalone.exe') {
            Copy-Item 'dist\\whisper-standalone.exe' '/host/dist/whisper-standalone.exe' -Force
            Write-Host '✅ Executable copied to host' -ForegroundColor Green
        } else {
            Write-Host '❌ Build failed - no executable found' -ForegroundColor Red
            exit 1
        }
    "

# Check if build succeeded
if [ -f "dist/whisper-standalone.exe" ]; then
    echo -e "\n${GREEN}🎉 Windows executable built successfully!${NC}"
    echo -e "${GREEN}=======================================${NC}"
    
    # Get file info
    SIZE_BYTES=$(stat -c%s "dist/whisper-standalone.exe")
    SIZE_MB=$(echo "scale=1; $SIZE_BYTES / 1048576" | bc)
    
    echo -e "\n${CYAN}📁 Executable ready:${NC}"
    echo -e "${GRAY}   Path: dist/whisper-standalone.exe${NC}"
    echo -e "${GRAY}   Size: ${SIZE_MB} MB${NC}"
    echo -e "${GRAY}   Target: Windows x64${NC}"
    
    echo -e "\n${CYAN}🎯 Next steps:${NC}"
    echo -e "${GRAY}   1. Copy to Windows machine for testing${NC}"
    echo -e "${GRAY}   2. Run: whisper-standalone.exe audio.wav${NC}"
    echo -e "${GRAY}   3. Or integrate into main MVP-Echo project${NC}"
    
else
    echo -e "${RED}❌ Build failed - no executable created${NC}"
    exit 1
fi