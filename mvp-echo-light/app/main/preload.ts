import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  startRecording: () => ipcRenderer.invoke('start-recording'),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  processAudio: (audioData: ArrayBuffer) => ipcRenderer.invoke('process-audio', audioData),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  
  // Event listeners
  onTranscriptionResult: (callback: (result: any) => void) => 
    ipcRenderer.on('transcription-result', callback),
  onAudioLevel: (callback: (level: number) => void) => 
    ipcRenderer.on('audio-level', callback),
  onGlobalShortcutStartRecording: (callback: () => void) => 
    ipcRenderer.on('global-shortcut-start-recording', callback),
  onGlobalShortcutStopRecording: (callback: () => void) => 
    ipcRenderer.on('global-shortcut-stop-recording', callback),
});

// Type declarations for TypeScript
declare global {
  interface Window {
    electronAPI: {
      startRecording: () => Promise<any>;
      stopRecording: () => Promise<any>;
      processAudio: (audioData: ArrayBuffer) => Promise<any>;
      getSystemInfo: () => Promise<any>;
      onTranscriptionResult: (callback: (result: any) => void) => void;
      onAudioLevel: (callback: (level: number) => void) => void;
      onGlobalShortcutStartRecording: (callback: () => void) => void;
      onGlobalShortcutStopRecording: (callback: () => void) => void;
    };
  }
}