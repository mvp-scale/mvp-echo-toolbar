/**
 * Browser Mock for Electron APIs
 * This allows the app to run in a browser during development
 */

// Mock system info
const mockSystemInfo = {
  platform: 'browser',
  arch: 'x64',
  cpus: navigator.hardwareConcurrency || 4,
  totalMemory: 16,
  freeMemory: 8,
  gpuInfo: {
    hasGPU: false,
    gpuName: 'Browser (No GPU)',
    vendor: 'Browser',
  },
  engineStatus: {
    currentEngine: 'mock',
    nativeAvailable: false,
    pythonAvailable: false,
  }
};

// Mock transcript for testing
const mockTranscripts = [
  "This is a mock transcription for browser development mode.",
  "The quick brown fox jumps over the lazy dog.",
  "Testing the voice to text functionality in browser mode.",
  "Real transcription requires running the Electron app.",
  "You can work on the UI using this mock data."
];

let transcriptIndex = 0;

// Create mock electronAPI
const mockElectronAPI = {
  startRecording: async () => {
    console.log('[Mock] startRecording called');
    return { success: true };
  },

  stopRecording: async () => {
    console.log('[Mock] stopRecording called');
    return { success: true };
  },

  processAudio: async (audioArray: ArrayBuffer | number[]) => {
    const byteLength = Array.isArray(audioArray) ? audioArray.length : audioArray.byteLength;
    console.log('[Mock] processAudio called with', byteLength, 'bytes');

    // Check if real Whisper server is available
    const USE_REAL_WHISPER = window.location.search.includes('realwhisper=true');

    if (USE_REAL_WHISPER) {
      console.log('[Real Whisper] Calling development server...');
      try {
        const audioBuffer = Array.isArray(audioArray)
          ? new Uint8Array(audioArray).buffer
          : audioArray;

        const response = await fetch('http://localhost:3001/transcribe', {
          method: 'POST',
          body: audioBuffer,
          headers: {
            'Content-Type': 'audio/webm'
          }
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const result = await response.json();
        console.log('[Real Whisper] ✅ Transcription:', result.text);
        return result;
      } catch (error) {
        console.error('[Real Whisper] ❌ Failed:', error);
        console.log('[Real Whisper] Falling back to mock...');
        // Fall through to mock
      }
    }

    // Mock transcription (default or fallback)
    await new Promise(resolve => setTimeout(resolve, 1500));
    const transcript = mockTranscripts[transcriptIndex % mockTranscripts.length];
    transcriptIndex++;
    return {
      success: true,
      text: transcript,
      transcript: transcript,
      engine: 'mock',
      processingTime: 1.5,
      duration: 3.5,
      language: 'en'
    };
  },

  onTranscriptionResult: (callback: Function) => {
    console.log('[Mock] onTranscriptionResult listener registered');
    // Mock doesn't use events, processAudio returns directly
  },

  getSystemInfo: async () => {
    console.log('[Mock] getSystemInfo called');
    return mockSystemInfo;
  },

  exportText: async (content: string, filename: string) => {
    console.log('[Mock] exportText called:', filename);
    // Trigger browser download
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    return { success: true };
  },

  copyToClipboard: async (text: string) => {
    console.log('[Mock] copyToClipboard called');
    try {
      await navigator.clipboard.writeText(text);
      return { success: true };
    } catch (err) {
      console.error('Failed to copy:', err);
      return { success: false, error: 'Clipboard access denied' };
    }
  },

  bringToForeground: async () => {
    console.log('[Mock] bringToForeground called (no-op in browser)');
    return { success: true };
  },

  onGlobalShortcutToggle: (callback: Function) => {
    console.log('[Mock] onGlobalShortcutToggle listener registered (no-op in browser)');
    // Can't register global shortcuts in browser
    return () => {}; // Return unsubscribe function
  }
};

// Create mock electron.ipcRenderer for setup components
const mockElectron = {
  ipcRenderer: {
    invoke: async (channel: string, ...args: any[]) => {
      console.log('[Mock] ipcRenderer.invoke:', channel, args);

      switch (channel) {
        case 'init:check':
          return { initialized: true, requiresSetup: false };

        case 'init:start':
          return { success: true };

        case 'init:get-status':
          return {
            stage: 'complete',
            message: 'Mock mode - no initialization needed',
            progress: 100
          };

        case 'engine:status':
          return {
            current: 'native',
            currentEngine: 'native',
            nativeAvailable: true,
            pythonAvailable: false,
            gpu: false
          };

        case 'engine:switch':
          console.log('[Mock] Switch engine to:', args[0]);
          return { success: true, currentEngine: args[0] };

        case 'engine:upgrade':
          console.log('[Mock] Upgrade engine');
          return { success: true };

        case 'engine:process-audio':
          return mockElectronAPI.processAudio(args[0]);

        default:
          console.warn('[Mock] Unknown IPC channel:', channel);
          return { success: false, error: 'Unknown channel' };
      }
    },

    on: (channel: string, callback: Function) => {
      console.log('[Mock] ipcRenderer.on:', channel);
      // No events in mock mode
    },

    removeListener: (channel: string, callback: Function) => {
      console.log('[Mock] ipcRenderer.removeListener:', channel);
    }
  }
};

// Initialize mocks when not in Electron
export function initializeBrowserMocks() {
  if (typeof window !== 'undefined' && !(window as any).electronAPI) {
    console.log('🌐 [Browser Mode] Initializing Electron API mocks');
    console.log('💡 To see the real app, run in Electron with required system libraries');

    (window as any).electronAPI = mockElectronAPI;
    (window as any).electron = mockElectron;

    console.log('✅ [Browser Mode] Mocks initialized successfully');
  }
}
