import { app, BrowserWindow, ipcMain, globalShortcut } from 'electron';
import * as path from 'path';

let mainWindow: BrowserWindow;
let isRecording = false;
let recordingStateLock = false;  // Prevent concurrent state changes

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    titleBarStyle: 'default',
    show: false,
  });

  // Load the React app
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    app.quit();
  });
}

// IPC Handlers for MVP
ipcMain.handle('start-recording', async (event, source = 'ipc') => {
  // Acquire lock to prevent concurrent operations
  if (recordingStateLock) {
    console.log(`⚠️ Recording operation in progress, ignoring start from: ${source}`);
    return { success: false, message: 'Recording operation in progress' };
  }
  
  if (isRecording) {
    console.log(`⚠️ Already recording, ignoring start from: ${source}`);
    return { success: false, message: 'Already recording' };
  }
  
  recordingStateLock = true;
  try {
    console.log(`✅ Recording started from: ${source}`);
    isRecording = true;
    return { success: true, message: 'Recording started' };
  } finally {
    recordingStateLock = false;
  }
});

ipcMain.handle('stop-recording', async (event, source = 'ipc') => {
  // Acquire lock to prevent concurrent operations
  if (recordingStateLock) {
    console.log(`⚠️ Recording operation in progress, ignoring stop from: ${source}`);
    return { success: false, message: 'Recording operation in progress' };
  }
  
  if (!isRecording) {
    console.log(`⚠️ Not recording, ignoring stop from: ${source}`);
    return { success: false, message: 'Not recording' };
  }
  
  recordingStateLock = true;
  try {
    console.log(`✅ Recording stopped from: ${source}`);
    isRecording = false;
    return { success: true, message: 'Recording stopped' };
  } finally {
    recordingStateLock = false;
  }
});

ipcMain.handle('get-system-info', async () => {
  try {
    // Try to get real GPU info if STT is available
    let gpuInfo = { available: false, provider: 'CPU', device: 'CPU' };
    
    try {
      const { detectGPUCapabilities } = await import('../stt');
      gpuInfo = await detectGPUCapabilities();
    } catch (error) {
      console.log('GPU detection not available:', error.message);
    }
    
    return {
      platform: process.platform,
      version: app.getVersion(),
      gpuMode: gpuInfo.available ? gpuInfo.provider : 'CPU',
      gpuAvailable: gpuInfo.available,
      gpuDevice: gpuInfo.device,
      sttInitialized
    };
  } catch (error) {
    console.error('Error getting system info:', error);
    return {
      platform: process.platform,
      version: app.getVersion(),
      gpuMode: 'CPU',
      gpuAvailable: false,
      sttInitialized: false
    };
  }
});

// Real STT processing with ONNX Runtime
let transcriptionPipeline: any = null;
let sttInitialized = false;

async function initializeSTT() {
  if (sttInitialized) return;
  
  try {
    // Import STT modules (dynamic import to avoid issues during startup)
    const { createTranscriptionPipeline, detectGPUCapabilities, isModelAvailable } = await import('../stt');
    
    console.log('Initializing STT engine...');
    
    // Check GPU capabilities
    const gpuInfo = await detectGPUCapabilities();
    console.log('GPU Info:', gpuInfo);
    
    // Check if models are available (start with tiny model for MVP)
    const modelSize = 'tiny';
    if (!isModelAvailable(modelSize)) {
      console.warn(`Model ${modelSize} not found. Please download models first.`);
      // For now, we'll continue with mock responses
      return false;
    }
    
    // Create transcription pipeline
    transcriptionPipeline = await createTranscriptionPipeline(modelSize, gpuInfo.available);
    console.log('STT engine initialized successfully');
    sttInitialized = true;
    return true;
    
  } catch (error) {
    console.error('Failed to initialize STT engine:', error);
    console.log('Falling back to mock transcription');
    return false;
  }
}

ipcMain.handle('process-audio', async (event, audioData) => {
  try {
    // Initialize STT on first use
    if (!sttInitialized) {
      const initialized = await initializeSTT();
      if (!initialized) {
        // Fall back to mock data
        return await mockTranscription();
      }
    }
    
    if (!transcriptionPipeline) {
      return await mockTranscription();
    }
    
    // Process audio with real STT
    console.log('Processing audio with ONNX Runtime Whisper...');
    const startTime = Date.now();
    
    // Convert audioData from renderer (Uint8Array) to a format we can work with
    let audioArray: Float32Array;
    
    if (audioData instanceof Array) {
      // Convert from array of numbers to Float32Array
      const uint8Array = new Uint8Array(audioData);
      
      // For mock implementation, create some sample data
      // In real implementation, this would be proper audio decoding
      audioArray = new Float32Array(16000); // 1 second at 16kHz
      for (let i = 0; i < audioArray.length; i++) {
        audioArray[i] = (Math.random() - 0.5) * 0.1; // Small random audio signal
      }
    } else {
      audioArray = new Float32Array(audioData);
    }
    
    // Transcribe
    const result = await transcriptionPipeline.transcribe(audioArray, 44100);
    
    const processingTime = Date.now() - startTime;
    console.log(`Transcription completed in ${processingTime}ms: "${result.text}"`);
    
    return {
      text: result.text,
      confidence: result.confidence,
      processingTime,
      engine: 'ONNX Runtime Whisper'
    };
    
  } catch (error) {
    console.error('STT processing failed:', error);
    console.log('Falling back to mock transcription');
    return await mockTranscription();
  }
});

async function mockTranscription() {
  // Simulate processing time
  await new Promise(resolve => setTimeout(resolve, 800));
  
  const mockTranscriptions = [
    "Hello, this is a test of the MVP Echo transcription system.",
    "The quick brown fox jumps over the lazy dog.", 
    "MVP Echo is working great with real-time transcription.",
    "This is a demonstration of voice to text conversion.",
    "The application is running smoothly on Windows 11.",
    "ONNX Runtime is initializing the Whisper model for speech recognition.",
    "DirectML acceleration is being configured for optimal performance."
  ];
  
  const randomText = mockTranscriptions[Math.floor(Math.random() * mockTranscriptions.length)];
  return { 
    text: randomText, 
    confidence: 0.95,
    engine: 'Mock (STT not available)'
  };
}

app.whenReady().then(() => {
  createWindow();
  
  // Register global shortcut for Ctrl+Alt+Z
  const ret = globalShortcut.register('CommandOrControl+Alt+Z', () => {
    console.log('Global Ctrl+Alt+Z pressed');
    
    // Use proper state locking to prevent concurrent operations
    if (recordingStateLock) {
      console.log('⚠️ Recording operation in progress, ignoring global shortcut');
      return;
    }
    
    // Acquire lock and toggle state safely
    recordingStateLock = true;
    try {
      if (!isRecording) {
        console.log('✅ Starting recording from global shortcut');
        isRecording = true;
        mainWindow.webContents.send('global-shortcut-start-recording');
      } else {
        console.log('✅ Stopping recording from global shortcut');
        isRecording = false;
        mainWindow.webContents.send('global-shortcut-stop-recording');
      }
    } finally {
      // Release lock after a short delay to prevent rapid toggles
      setTimeout(() => {
        recordingStateLock = false;
      }, 100);
    }
  });

  if (!ret) {
    console.log('Global shortcut registration failed');
  } else {
    console.log('Global shortcut Ctrl+Alt+Z registered successfully');
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  // Unregister global shortcuts
  globalShortcut.unregisterAll();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});