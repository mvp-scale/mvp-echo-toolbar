# MVP-Echo Development Script
Write-Host "Starting MVP-Echo Development Environment..." -ForegroundColor Green

# Check if Node.js is installed
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Node.js is not installed. Please install Node.js 18+ first." -ForegroundColor Red
    exit 1
}

# Check if npm dependencies are installed
if (-not (Test-Path "node_modules")) {
    Write-Host "📦 Installing dependencies..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Failed to install dependencies" -ForegroundColor Red
        exit 1
    }
}

# Start development server
Write-Host "🚀 Starting development server..." -ForegroundColor Green
Write-Host "   • Renderer: http://localhost:5173" -ForegroundColor Cyan
Write-Host "   • Main process: Building and watching..." -ForegroundColor Cyan
Write-Host "   • Press Ctrl+C to stop" -ForegroundColor Yellow

npm run dev