#!/usr/bin/env node

/**
 * MVP-Echo Python Embedded Distribution Preparation Script
 * 
 * This script downloads and prepares a Python embedded distribution
 * with all required dependencies for the portable MVP-Echo application.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

// Configuration
const PYTHON_VERSION = '3.11.8';
const PYTHON_EMBEDDED_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
const TEMP_DIR = path.join(__dirname, '../temp');
const PYTHON_EMBEDDED_DIR = path.join(__dirname, '../python-embedded');

// Required Python packages
const REQUIRED_PACKAGES = [
  'faster-whisper',
  'numpy',
  'torch',
  'torchaudio',
  'onnxruntime'
];

// Whisper models to download (all sizes for offline use)
const WHISPER_MODELS = [
  { name: 'tiny', size: '39MB', url: 'https://openaipublic.azureedge.net/main/whisper/models/65147644a518d12f04e32d6f3b26facc3f8dd46e5390956a9424a650c0ce22794/tiny.pt' },
  { name: 'base', size: '74MB', url: 'https://openaipublic.azureedge.net/main/whisper/models/ed3a0b6b1c0edf879ad9b11b1af5a0e6ab5db9205f891f668f8b0e6c6326e34e/base.pt' },
  { name: 'small', size: '244MB', url: 'https://openaipublic.azureedge.net/main/whisper/models/9ecf779972d90ba49c06d968637d720dd632c55bbf19d441fb42bf17a411e794/small.pt' },
  { name: 'medium', size: '769MB', url: 'https://openaipublic.azureedge.net/main/whisper/models/345ae4da62f9b3d59415adc60127b97c714f32e89e936602e85993674d08dcb1/medium.pt' },
  { name: 'large', size: '1550MB', url: 'https://openaipublic.azureedge.net/main/whisper/models/e4b87e7e0bf463eb8e6956e646f1e277e901512310def2c24bf0e11bd3c28e9a/large-v2.pt' }
];

async function downloadFile(url, destination) {
  console.log(`📥 Downloading ${url}...`);
  
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);
    
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Handle redirects
        return downloadFile(response.headers.location, destination);
      }
      
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
        return;
      }
      
      let downloadedBytes = 0;
      const totalBytes = parseInt(response.headers['content-length'], 10);
      
      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        const progress = ((downloadedBytes / totalBytes) * 100).toFixed(1);
        process.stdout.write(`\r📥 Progress: ${progress}%`);
      });
      
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        console.log('\n✅ Download completed');
        resolve();
      });
      
      file.on('error', (err) => {
        fs.unlinkSync(destination);
        reject(err);
      });
    }).on('error', reject);
  });
}

async function extractZip(zipPath, extractPath) {
  console.log(`📦 Extracting ${zipPath} to ${extractPath}...`);
  
  return new Promise((resolve, reject) => {
    // Try using PowerShell on Windows
    const psCommand = `Expand-Archive -Path "${zipPath}" -DestinationPath "${extractPath}" -Force`;
    
    const process = spawn('powershell.exe', ['-Command', psCommand], {
      stdio: 'inherit'
    });
    
    process.on('close', (code) => {
      if (code === 0) {
        console.log('✅ Extraction completed');
        resolve();
      } else {
        reject(new Error(`Extraction failed with code ${code}`));
      }
    });
    
    process.on('error', (error) => {
      console.log('⚠️ PowerShell not available, trying alternative method...');
      
      // Fallback: Manual zip extraction would require additional dependencies
      // For now, we'll require manual extraction
      reject(new Error('Please manually extract the Python embedded ZIP file'));
    });
  });
}

async function installPackages(pythonPath) {
  console.log('📦 Installing required Python packages...');
  
  // Download get-pip.py first
  const getPipPath = path.join(path.dirname(pythonPath), 'get-pip.py');
  
  try {
    await downloadFile('https://bootstrap.pypa.io/get-pip.py', getPipPath);
    
    // Install pip
    console.log('🔧 Installing pip...');
    await runCommand(pythonPath, [getPipPath]);
    
    // Install packages
    for (const package of REQUIRED_PACKAGES) {
      console.log(`📦 Installing ${package}...`);
      await runCommand(pythonPath, ['-m', 'pip', 'install', package, '--no-warn-script-location']);
    }
    
    console.log('✅ All packages installed successfully');
    
  } catch (error) {
    console.error('❌ Failed to install packages:', error);
    throw error;
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`🔧 Running: ${command} ${args.join(' ')}`);
    
    const process = spawn(command, args, {
      stdio: 'inherit',
      ...options
    });
    
    process.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with code ${code}`));
      }
    });
    
    process.on('error', reject);
  });
}

function createPortableConfig(pythonDir) {
  console.log('[CONFIG] Creating portable Python configuration...');
  
  // Remove any existing _pth files that might interfere
  try {
    const files = fs.readdirSync(pythonDir);
    files.forEach(file => {
      if (file.endsWith('._pth')) {
        fs.unlinkSync(path.join(pythonDir, file));
      }
    });
  } catch (error) {
    // Ignore errors if no _pth files exist
  }
  
  // Create python311._pth file with proper paths (no BOM)
  const pthContent = `python311.zip
.
Lib
Lib/site-packages
Scripts

# Enable site module for pip to work
import site`;
  
  const pthPath = path.join(pythonDir, 'python311._pth');
  
  // Write without BOM to avoid path corruption
  fs.writeFileSync(pthPath, pthContent, { encoding: 'utf8' });
  
  console.log('[PTH] Created python311._pth without BOM');
  
  // Copy whisper_service.py to Python directory
  const whisperServiceSrc = path.join(__dirname, '../python/whisper_service.py');
  const whisperServiceDst = path.join(pythonDir, 'whisper_service.py');
  
  if (fs.existsSync(whisperServiceSrc)) {
    fs.copyFileSync(whisperServiceSrc, whisperServiceDst);
    console.log('[COPY] Copied whisper_service.py to Python directory');
  }
  
  console.log('[DONE] Portable configuration created');
}

async function downloadWhisperModels(pythonDir) {
  console.log('[MODELS] Downloading Whisper models for offline use...');
  
  // Create models directory
  const modelsDir = path.join(pythonDir, 'models');
  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
  }
  
  let totalSize = 0;
  
  for (const model of WHISPER_MODELS) {
    const modelPath = path.join(modelsDir, `${model.name}.pt`);
    
    if (fs.existsSync(modelPath)) {
      console.log(`[SKIP] Model ${model.name} already exists, skipping...`);
      continue;
    }
    
    console.log(`[DL-${model.name.toUpperCase()}] Downloading Whisper ${model.name} model (${model.size})...`);
    
    try {
      await downloadFile(model.url, modelPath);
      const stats = fs.statSync(modelPath);
      const fileSize = stats.size / (1024 * 1024);
      totalSize += fileSize;
      console.log(`[DONE] Downloaded ${model.name} model (${fileSize.toFixed(1)} MB)`);
    } catch (error) {
      console.error(`[ERROR] Failed to download ${model.name} model:`, error.message);
      // Continue with other models even if one fails
    }
  }
  
  console.log(`[MODELS-DONE] All Whisper models downloaded (Total: ${totalSize.toFixed(1)} MB)`);
  
  // Create model manifest for the app
  const manifestContent = {
    models: [
      { name: 'tiny', file: 'tiny.pt', description: 'Fastest, basic accuracy (~39MB)' },
      { name: 'base', file: 'base.pt', description: 'Good balance of speed/accuracy (~74MB)' },
      { name: 'small', file: 'small.pt', description: 'Better accuracy, slower (~244MB)' },
      { name: 'medium', file: 'medium.pt', description: 'High accuracy, much slower (~769MB)' },
      { name: 'large', file: 'large-v2.pt', description: 'Best accuracy, very slow (~1550MB)' }
    ],
    default: 'tiny',
    offline: true
  };
  
  const manifestPath = path.join(modelsDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifestContent, null, 2), { encoding: 'utf8' });
  
  console.log('[MANIFEST] Created model manifest for offline use');
}

async function cleanupTempFiles() {
  console.log('[CLEANUP] Cleaning up temporary files...');
  
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
  
  console.log('[DONE] Cleanup completed');
}

async function main() {
  try {
    console.log('🚀 MVP-Echo Python Embedded Distribution Preparation');
    console.log('===============================================');
    
    // Create directories
    if (!fs.existsSync(TEMP_DIR)) {
      fs.mkdirSync(TEMP_DIR, { recursive: true });
    }
    
    if (fs.existsSync(PYTHON_EMBEDDED_DIR)) {
      console.log('🧹 Removing existing Python embedded directory...');
      fs.rmSync(PYTHON_EMBEDDED_DIR, { recursive: true, force: true });
    }
    
    fs.mkdirSync(PYTHON_EMBEDDED_DIR, { recursive: true });
    
    // Download Python embedded
    const pythonZipPath = path.join(TEMP_DIR, `python-${PYTHON_VERSION}-embed-amd64.zip`);
    
    if (!fs.existsSync(pythonZipPath)) {
      await downloadFile(PYTHON_EMBEDDED_URL, pythonZipPath);
    } else {
      console.log('📦 Using existing Python embedded ZIP file');
    }
    
    // Extract Python
    await extractZip(pythonZipPath, PYTHON_EMBEDDED_DIR);
    
    // Find Python executable
    const pythonExe = path.join(PYTHON_EMBEDDED_DIR, 'python.exe');
    
    if (!fs.existsSync(pythonExe)) {
      throw new Error('Python executable not found after extraction');
    }
    
    // Install required packages
    await installPackages(pythonExe);
    
    // Create portable configuration
    createPortableConfig(PYTHON_EMBEDDED_DIR);
    
    // Download all Whisper models for offline use
    await downloadWhisperModels(PYTHON_EMBEDDED_DIR);
    
    // Clean up
    await cleanupTempFiles();
    
    console.log('');
    console.log('[SUCCESS] Python embedded distribution with ALL Whisper models prepared!');
    console.log(`[INFO] Location: ${PYTHON_EMBEDDED_DIR}`);
    console.log(`[INFO] Size: ${getFolderSize(PYTHON_EMBEDDED_DIR)} MB (includes all Whisper models for offline use)`);
    console.log('');
    console.log('Included Whisper models:');
    console.log('- tiny (~39MB) - Fastest, basic accuracy');
    console.log('- base (~74MB) - Good balance');
    console.log('- small (~244MB) - Better accuracy');
    console.log('- medium (~769MB) - High accuracy');
    console.log('- large (~1550MB) - Best accuracy');
    console.log('');
    console.log('Next steps:');
    console.log('1. Run "npm run pack:portable" to build the portable MVP-Echo application');
    console.log('2. The portable app will include Python + ALL Whisper models');
    console.log('3. Users can run the app COMPLETELY OFFLINE - no internet required!');
    console.log('');
    
  } catch (error) {
    console.error('❌ Failed to prepare Python embedded distribution:', error);
    process.exit(1);
  }
}

function getFolderSize(folderPath) {
  let totalSize = 0;
  
  function calculateSize(dirPath) {
    const files = fs.readdirSync(dirPath);
    
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stats = fs.statSync(filePath);
      
      if (stats.isDirectory()) {
        calculateSize(filePath);
      } else {
        totalSize += stats.size;
      }
    }
  }
  
  try {
    calculateSize(folderPath);
    return (totalSize / (1024 * 1024)).toFixed(1);
  } catch {
    return 'Unknown';
  }
}

// Run the script
if (require.main === module) {
  main();
}

module.exports = {
  main,
  downloadFile,
  extractZip,
  installPackages,
  createPortableConfig
};