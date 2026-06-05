const { contextBridge, ipcRenderer } = require('electron');

console.log('MVP-Echo Toolbar: Preload script loaded');

// Expose APIs for both hidden capture window and popup window
contextBridge.exposeInMainWorld('electronAPI', {
  // Audio processing
  startRecording: (source) => ipcRenderer.invoke('start-recording', source),
  stopRecording: (source) => ipcRenderer.invoke('stop-recording', source),
  processAudio: (audioArray, options) => ipcRenderer.invoke('processAudio', audioArray, options),

  // Clipboard
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),

  // Tray state updates (from hidden window)
  updateTrayState: (state) => ipcRenderer.invoke('tray:update-state', state),

  // Global shortcut listener (hidden window)
  onGlobalShortcutToggle: (callback) => {
    ipcRenderer.removeAllListeners('global-shortcut-toggle');
    ipcRenderer.on('global-shortcut-toggle', callback);
    return () => ipcRenderer.removeAllListeners('global-shortcut-toggle');
  },

  // Countdown: hidden window sends updates to main, which forwards to popup
  sendCountdownUpdate: (data) => ipcRenderer.invoke('countdown:update', data),

  // Countdown: popup listens for countdown updates from main
  onCountdownUpdate: (callback) => {
    ipcRenderer.removeAllListeners('countdown-update');
    ipcRenderer.on('countdown-update', (_event, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('countdown-update');
  },

  // Popup: get last transcription
  getLastTranscription: () => ipcRenderer.invoke('get-last-transcription'),

  // Popup: listen for transcription updates
  onTranscriptionUpdated: (callback) => {
    ipcRenderer.removeAllListeners('transcription-updated');
    ipcRenderer.on('transcription-updated', (_event, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('transcription-updated');
  },

  // Popup: copy and close
  copyAndClose: () => ipcRenderer.invoke('popup:copy-and-close'),

  // Popup: hide
  hidePopup: () => ipcRenderer.invoke('popup:hide'),

  // Welcome screen
  getWelcomePreference: () => ipcRenderer.invoke('welcome:get-preference'),
  setWelcomePreference: (pref) => ipcRenderer.invoke('welcome:set-preference', pref),
  closeWelcome: () => ipcRenderer.invoke('welcome:close'),

  // App info
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),

  // Last-resort recovery: ask main to reload the hidden capture window when the
  // audio pipeline is wedged and an in-renderer engine rebuild didn't recover.
  requestCaptureReload: () => ipcRenderer.invoke('capture:request-reload'),


  // WebGPU adapter -- transcription result from renderer-side inference
  webgpuStoreTranscription: (result) => ipcRenderer.invoke('webgpu:store-transcription', result),

  // WebGPU -- listen for orchestrator init request from main
  onWebgpuInitOrchestrator: (callback) => {
    ipcRenderer.removeAllListeners('webgpu:init-orchestrator');
    ipcRenderer.on('webgpu:init-orchestrator', () => callback());
    return () => ipcRenderer.removeAllListeners('webgpu:init-orchestrator');
  },
});

// Cloud configuration IPC (used by popup settings panel)
contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: {
    invoke: (channel, ...args) => {
      const validChannels = [
        'cloud:configure', 'cloud:test-connection', 'cloud:get-config',
        'engine:list-models', 'engine:switch-model', 'engine:status',
        'debug:open-devtools', 'debug:renderer-log',
        'webgpu:check-availability', 'webgpu:model-status',
        'webgpu:model-ready',
      ];
      if (validChannels.includes(channel)) {
        return ipcRenderer.invoke(channel, ...args);
      }
    },
    on: (channel, callback) => {
      ipcRenderer.on(channel, callback);
    },
    removeListener: (channel, callback) => {
      ipcRenderer.removeListener(channel, callback);
    },
  }
});
