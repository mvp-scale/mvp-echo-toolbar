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
});

// Cloud configuration IPC (used by popup settings panel)
contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: {
    invoke: (channel, ...args) => {
      const validChannels = [
        'cloud:configure', 'cloud:test-connection', 'cloud:get-config',
        'engine:list-models', 'engine:switch-model', 'engine:status',
        'debug:open-devtools', 'debug:renderer-log'
      ];
      if (validChannels.includes(channel)) {
        return ipcRenderer.invoke(channel, ...args);
      }
    },
  }
});
