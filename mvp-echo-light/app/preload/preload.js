const { contextBridge, ipcRenderer } = require('electron');

console.log('MVP-Echo: Preload script loaded successfully');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // STT functions
  startRecording: () => ipcRenderer.invoke('start-recording'),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  processAudio: (audioArray, options = {}) => ipcRenderer.invoke('processAudio', audioArray, options),
  onTranscriptionResult: (callback) => ipcRenderer.on('transcription-result', callback),
  
  // System info
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  
  // File operations
  exportText: (content, filename) => ipcRenderer.invoke('export-text', content, filename),
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
  bringToForeground: () => ipcRenderer.invoke('bring-to-foreground'),
  
  // Global shortcut event listeners
  onGlobalShortcutToggle: (callback) => {
    // Remove any existing listeners to prevent accumulation
    ipcRenderer.removeAllListeners('global-shortcut-toggle');
    return ipcRenderer.on('global-shortcut-toggle', callback);
  },
});

// Also expose electron IPC for setup and engine components
contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: {
    invoke: (channel, ...args) => {
      const validChannels = [
        'init:check', 'init:start', 'init:get-status',
        'engine:status', 'engine:switch', 'engine:upgrade', 'engine:process-audio',
        // Cloud channels for MVP-Echo Light
        'cloud:configure', 'cloud:test-connection', 'cloud:get-config'
      ];
      if (validChannels.includes(channel)) {
        return ipcRenderer.invoke(channel, ...args);
      }
    },
    on: (channel, callback) => {
      const validChannels = ['init:status', 'engine:upgrade-progress'];
      if (validChannels.includes(channel)) {
        ipcRenderer.on(channel, callback);
      }
    },
    removeListener: (channel, callback) => {
      ipcRenderer.removeListener(channel, callback);
    }
  }
});