import { useEffect, useRef } from 'react';
import { AudioCapture } from './audio/AudioCapture';
import { playCompletionSound } from './audio/completion-sound';
import { playWarningSound } from './audio/warning-sound';

// ── Countdown timing constants ──
const MAX_RECORDING_S = 600;    // Server limit (10 min)
const COUNTDOWN_START_S = 540;  // Show countdown at 9 min (1 min warning)
const AUTO_STOP_S = 590;        // Auto-stop at 9:50 (10s buffer)

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
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedRef = useRef(0);

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

    /** Clear countdown interval and notify popup */
    const clearCountdown = () => {
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
      elapsedRef.current = 0;
      // Tell popup to dismiss countdown
      api.sendCountdownUpdate({ active: false, remaining: 0, total: MAX_RECORDING_S });
    };

    /** Start the 1-second countdown interval */
    const startCountdownInterval = () => {
      elapsedRef.current = 0;
      countdownIntervalRef.current = setInterval(() => {
        if (!isRecordingRef.current) {
          clearCountdown();
          return;
        }

        elapsedRef.current += 1;
        const elapsed = elapsedRef.current;

        // At COUNTDOWN_START_S: play warning sound and begin sending countdown updates
        if (elapsed === COUNTDOWN_START_S) {
          playWarningSound();
          console.log(`CaptureApp: Countdown started at ${elapsed}s`);
        }

        // Send countdown updates from COUNTDOWN_START_S onward
        if (elapsed >= COUNTDOWN_START_S) {
          const remaining = MAX_RECORDING_S - elapsed;
          api.sendCountdownUpdate({
            active: true,
            remaining,
            total: MAX_RECORDING_S,
          });
        }

        // At AUTO_STOP_S: auto-stop recording
        if (elapsed >= AUTO_STOP_S) {
          console.log(`CaptureApp: Auto-stopping at ${elapsed}s (limit: ${AUTO_STOP_S}s)`);
          performStop(api);
        }
      }, 1000);
    };

    /** Shared stop logic — used by both manual stop and auto-stop */
    const performStop = async (electronAPI: any) => {
      if (!isRecordingRef.current) return;

      console.log('CaptureApp: Stopping recording');
      isRecordingRef.current = false;
      clearCountdown();
      electronAPI.updateTrayState('processing');
      electronAPI.stopRecording('global-shortcut');

      try {
        const audioBuffer: ArrayBuffer = await audioCapture.current.stopRecording();
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
          const result = await electronAPI.processAudio(audioArray, {
            model: selectedModelRef.current,
            language: selectedLanguageRef.current,
          });

          console.log('CaptureApp: Transcription result:', JSON.stringify(result));

          if (result.text?.trim()) {
            await electronAPI.copyToClipboard(result.text);
            console.log(`CaptureApp: Copied to clipboard: "${result.text}"`);
            playCompletionSound();
            electronAPI.updateTrayState('done');
          } else {
            console.log('CaptureApp: Empty transcription, no copy');
            electronAPI.updateTrayState('ready');
          }
        } else {
          console.warn('CaptureApp: Empty audio buffer, skipping transcription');
          electronAPI.updateTrayState('ready');
        }
      } catch (error: any) {
        console.error('CaptureApp: Stop recording failed:', error);
        electronAPI.updateTrayState('error');
        setTimeout(() => electronAPI.updateTrayState('ready'), 3000);
      }
    };

    const unsubscribe = api.onGlobalShortcutToggle(() => {
      console.log('CaptureApp: Global shortcut toggle received');

      const currentlyRecording = isRecordingRef.current;

      if (currentlyRecording) {
        // ── Stop Recording (manual) ──
        performStop(api);
      } else {
        // ── Start Recording ──
        console.log('CaptureApp: Starting recording');
        isRecordingRef.current = true;
        api.updateTrayState('recording');
        api.startRecording('global-shortcut');

        // Start countdown interval
        startCountdownInterval();

        audioCapture.current.startRecording().catch((error: Error) => {
          console.error('CaptureApp: Start recording failed:', error);
          isRecordingRef.current = false;
          clearCountdown();
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
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
      }
      audioCapture.current.cleanup();
    };
  }, []);

  // Cleanup on window unload
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
      }
      audioCapture.current.cleanup();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // No visible UI - this is a hidden window
  return null;
}
