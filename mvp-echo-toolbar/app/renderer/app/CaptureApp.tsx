import { useEffect, useRef } from 'react';
import { AudioCapture } from './audio/AudioCapture';
import { playCompletionSound } from './audio/completion-sound';

/**
 * CaptureApp - Hidden window component for audio capture
 * No visible DOM. All logic runs in useEffect.
 * Listens for global shortcut toggle, manages recording, plays ding, auto-copies.
 */
export default function CaptureApp() {
  const audioCapture = useRef(new AudioCapture());
  const isRecordingRef = useRef(false);
  const selectedModelRef = useRef('gpu-english');
  const selectedLanguageRef = useRef('');

  // Load saved config on mount to get model/language
  useEffect(() => {
    const ipc = (window as any).electron?.ipcRenderer;
    if (!ipc) return; // Not in Electron (e.g., browser viewing Vite dev server)

    const loadConfig = async () => {
      try {
        const config = await ipc.invoke('cloud:get-config');
        if (config) {
          if (config.selectedModel) selectedModelRef.current = config.selectedModel;
          if (config.language) selectedLanguageRef.current = config.language;
        }
      } catch (e) {
        console.warn('Failed to load cloud config:', e);
      }
    };
    loadConfig();
  }, []);

  // Listen for config changes from popup (re-check periodically or on events)
  // The popup saves config via cloud:configure IPC, so we re-read before each transcription

  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api) return;

    // Forward renderer console to main process log file
    const ipc = (window as any).electron?.ipcRenderer;
    const origLog = console.log;
    const origError = console.error;
    const origWarn = console.warn;
    console.log = (...args: any[]) => {
      origLog(...args);
      if (ipc) ipc.invoke('debug:renderer-log', args.map(String).join(' ')).catch(() => {});
    };
    console.error = (...args: any[]) => {
      origError(...args);
      if (ipc) ipc.invoke('debug:renderer-log', 'ERROR: ' + args.map(String).join(' ')).catch(() => {});
    };
    console.warn = (...args: any[]) => {
      origWarn(...args);
      if (ipc) ipc.invoke('debug:renderer-log', 'WARN: ' + args.map(String).join(' ')).catch(() => {});
    };

    console.log('CaptureApp: Setting up global shortcut listener');

    const unsubscribe = api.onGlobalShortcutToggle(() => {
      console.log('CaptureApp: Global shortcut toggle received');

      const currentlyRecording = isRecordingRef.current;

      if (currentlyRecording) {
        // ── Stop Recording ──
        console.log('CaptureApp: Stopping recording');
        isRecordingRef.current = false;
        api.updateTrayState('processing');
        api.stopRecording('global-shortcut');

        audioCapture.current.stopRecording().then(async (audioBuffer: ArrayBuffer) => {
          console.log(`CaptureApp: Audio buffer received, ${audioBuffer.byteLength} bytes`);

          if (audioBuffer.byteLength > 0) {
            // Re-read latest config before processing
            try {
              const ipc = (window as any).electron?.ipcRenderer;
              if (ipc) {
                const config = await ipc.invoke('cloud:get-config');
                if (config) {
                  if (config.selectedModel) selectedModelRef.current = config.selectedModel;
                  if (config.language) selectedLanguageRef.current = config.language;
                }
              }
            } catch (_e) { /* use cached values */ }

            console.log(`CaptureApp: Sending to engine (model: ${selectedModelRef.current}, language: ${selectedLanguageRef.current || 'auto'})`);
            const audioArray = Array.from(new Uint8Array(audioBuffer));
            const result = await api.processAudio(audioArray, {
              model: selectedModelRef.current,
              language: selectedLanguageRef.current,
            });

            console.log('CaptureApp: Transcription result:', JSON.stringify(result));

            if (result.text?.trim()) {
              await api.copyToClipboard(result.text);
              console.log(`CaptureApp: Copied to clipboard: "${result.text}"`);
              playCompletionSound();
              api.updateTrayState('done');
            } else {
              console.log('CaptureApp: Empty transcription, no copy');
              api.updateTrayState('ready');
            }
          } else {
            console.warn('CaptureApp: Empty audio buffer, skipping transcription');
            api.updateTrayState('ready');
          }
        }).catch((error: Error) => {
          console.error('CaptureApp: Stop recording failed:', error);
          api.updateTrayState('error');
          setTimeout(() => api.updateTrayState('ready'), 3000);
        });
      } else {
        // ── Start Recording ──
        console.log('CaptureApp: Starting recording');
        isRecordingRef.current = true;
        api.updateTrayState('recording');
        api.startRecording('global-shortcut');

        audioCapture.current.startRecording().catch((error: Error) => {
          console.error('CaptureApp: Start recording failed:', error);
          isRecordingRef.current = false;
          api.updateTrayState('error');
          setTimeout(() => api.updateTrayState('ready'), 3000);
        });
      }
    });

    // Cleanup on unmount
    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
      audioCapture.current.cleanup();
    };
  }, []);

  // Cleanup on window unload
  useEffect(() => {
    const handleBeforeUnload = () => {
      audioCapture.current.cleanup();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // No visible UI - this is a hidden window
  return null;
}
