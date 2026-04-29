import { useCallback, useEffect, useRef } from 'react';
import { AudioCapture } from './audio/AudioCapture';
import { playCompletionSound } from './audio/completion-sound';
import { playWarningSound } from './audio/warning-sound';
import { InferenceOrchestrator } from './webgpu/inference-orchestrator';

// ── Silence trimming (Parakeet is VAD-sensitive) ──
function trimSilence(audio: Float32Array, threshold = 0.01): Float32Array {
  let start = 0, end = audio.length - 1;
  while (start < end && Math.abs(audio[start]) < threshold) start++;
  while (end > start && Math.abs(audio[end]) < threshold) end--;
  const pad = 1600; // 100ms at 16kHz
  return audio.slice(Math.max(0, start - pad), Math.min(audio.length, end + pad + 1));
}

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
  const isProcessingRef = useRef(false);
  const selectedModelRef = useRef('');
  const selectedLanguageRef = useRef('');
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedRef = useRef(0);
  const orchestratorRef = useRef<InferenceOrchestrator>(new InferenceOrchestrator());
  const rawPcmActiveRef = useRef(false); // tracks which recording mode was used

  const initWebGpuOrchestrator = useCallback(async () => {
    const api = (window as any).electronAPI;
    if (orchestratorRef.current.isReady() || orchestratorRef.current.isLoading()) return;
    try {
      let backend: 'webgpu-hybrid' | 'wasm' = 'wasm';
      if ((navigator as any).gpu) {
        try {
          const adapter = await (navigator as any).gpu.requestAdapter();
          if (adapter) backend = 'webgpu-hybrid';
        } catch { /* wasm fallback */ }
      }
      let appVersion: string | undefined;
      try {
        appVersion = await api?.getAppVersion?.();
      } catch { /* cache versioning is best-effort */ }
      console.log(`CaptureApp: Initializing parakeet.js orchestrator (${backend}, v=${appVersion ?? 'unknown'})...`);
      await orchestratorRef.current.initialize(backend, appVersion);
      console.log('CaptureApp: WebGPU orchestrator ready');

      const ipc = (window as any).electron?.ipcRenderer;
      if (ipc) ipc.invoke('webgpu:model-ready', true);
    } catch (e) {
      console.warn('CaptureApp: WebGPU orchestrator init failed:', e);
    }
  }, []);

  // Load saved config on mount.
  // If a WebGPU model was previously selected, auto-init the orchestrator —
  // the IndexedDB blob cache makes this near-instant and avoids the user
  // having to re-select the model after every restart.
  useEffect(() => {
    const ipc = (window as any).electron?.ipcRenderer;
    if (!ipc) return;

    const loadConfig = async () => {
      try {
        const config = await ipc.invoke('cloud:get-config');
        if (config) {
          if (config.selectedModel) selectedModelRef.current = config.selectedModel;
          if (config.language) selectedLanguageRef.current = config.language;
        }
        console.log(`CaptureApp: Config loaded, model=${selectedModelRef.current}`);
        if (selectedModelRef.current.startsWith('webgpu-')) {
          console.log('CaptureApp: Restored WebGPU model — auto-initializing orchestrator');
          initWebGpuOrchestrator();
        }
      } catch (e) {
        console.warn('CaptureApp: Failed to load config:', e);
      }
    };

    loadConfig();

    return () => {
      orchestratorRef.current.dispose();
    };
  }, [initWebGpuOrchestrator]);

  // Listen for WebGPU init request from main (triggered when user selects WebGPU model in settings)
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.onWebgpuInitOrchestrator) return;

    const unsub = api.onWebgpuInitOrchestrator(() => {
      console.log('CaptureApp: Received webgpu:init-orchestrator from main');
      initWebGpuOrchestrator();
    });

    return () => { if (typeof unsub === 'function') unsub(); };
  }, [initWebGpuOrchestrator]);

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

    /** Reset all state to known good — safety valve */
    const resetState = (electronAPI: any) => {
      console.log('CaptureApp: RESET — clearing all state');
      isRecordingRef.current = false;
      isProcessingRef.current = false;
      rawPcmActiveRef.current = false;
      clearCountdown();
      audioCapture.current.cleanup();
      electronAPI.updateTrayState('ready');
    };

    /** Shared stop logic — used by both manual stop and auto-stop */
    const performStop = async (electronAPI: any) => {
      if (!isRecordingRef.current) {
        console.log('CaptureApp: performStop called but not recording, resetting');
        resetState(electronAPI);
        return;
      }

      const wasRawPcm = rawPcmActiveRef.current;
      console.log(`CaptureApp: Stopping recording (mode=${wasRawPcm ? 'raw-pcm' : 'webm'})`);
      isRecordingRef.current = false;
      isProcessingRef.current = true;
      clearCountdown();
      electronAPI.updateTrayState('processing');
      electronAPI.stopRecording('global-shortcut');

      // Safety timeout: if processing takes >60s, force reset
      const safetyTimeout = setTimeout(() => {
        console.error('CaptureApp: SAFETY TIMEOUT — processing exceeded 60s, resetting');
        resetState(electronAPI);
      }, 60000);

      try {
        if (wasRawPcm && orchestratorRef.current.isReady()) {
          // ── WebGPU LOCAL PATH ──
          console.log('CaptureApp: Stopping raw PCM capture...');
          const { pcm, sampleRate } = await audioCapture.current.stopRawRecording();
          console.log(`CaptureApp: Got ${pcm.length} samples (${(pcm.length / sampleRate).toFixed(1)}s)`);

          if (pcm.length > 0) {
            const trimmed = trimSilence(pcm);
            console.log(`CaptureApp: Trimmed to ${trimmed.length} samples, sending to parakeet.js`);
            const result = await orchestratorRef.current.transcribe(trimmed, sampleRate);
            console.log(`CaptureApp: Result: "${result.text}" (${result.processingTime.toFixed(0)}ms)`);

            if (result.text?.trim()) {
              await electronAPI.copyToClipboard(result.text);
              playCompletionSound();
              electronAPI.updateTrayState('done');
              electronAPI.webgpuStoreTranscription({
                text: result.text,
                processingTime: result.processingTime,
                engine: `webgpu (${selectedModelRef.current})`,
                model: selectedModelRef.current,
                language: 'en',
              });
            } else {
              electronAPI.updateTrayState('ready');
            }
          } else {
            console.warn('CaptureApp: Empty audio');
            electronAPI.updateTrayState('ready');
          }
        } else {
          // ── STANDARD PATH ──
          console.log('CaptureApp: Stopping MediaRecorder...');
          const audioBuffer: ArrayBuffer = await audioCapture.current.stopRecording();
          console.log(`CaptureApp: Got ${audioBuffer.byteLength} bytes`);

          if (audioBuffer.byteLength > 0) {
            // Re-read config for model/language
            try {
              const ipc = (window as any).electron?.ipcRenderer;
              if (ipc) {
                const config = await ipc.invoke('cloud:get-config');
                if (config?.selectedModel) selectedModelRef.current = config.selectedModel;
                if (config?.language) selectedLanguageRef.current = config.language;
              }
            } catch (_e) { /* use cached */ }

            console.log(`CaptureApp: Sending to engine (model=${selectedModelRef.current})`);
            const audioArray = Array.from(new Uint8Array(audioBuffer));
            const result = await electronAPI.processAudio(audioArray, {
              model: selectedModelRef.current,
              language: selectedLanguageRef.current,
            });

            if (result.success === false) {
              console.error('CaptureApp: Transcription failed:', result.error);
              electronAPI.updateTrayState('error');
              setTimeout(() => electronAPI.updateTrayState('ready'), 3000);
            } else if (result.text?.trim()) {
              await electronAPI.copyToClipboard(result.text);
              playCompletionSound();
              electronAPI.updateTrayState('done');
            } else {
              electronAPI.updateTrayState('ready');
            }
          } else {
            electronAPI.updateTrayState('ready');
          }
        }
      } catch (error: any) {
        console.error('CaptureApp: performStop error:', error);
        electronAPI.updateTrayState('error');
        setTimeout(() => electronAPI.updateTrayState('ready'), 3000);
      } finally {
        clearTimeout(safetyTimeout);
        isProcessingRef.current = false;
        rawPcmActiveRef.current = false;
        console.log('CaptureApp: performStop complete, state=ready');
      }
    };

    const unsubscribe = api.onGlobalShortcutToggle(() => {
      console.log('CaptureApp: Global shortcut toggle received');

      if (isProcessingRef.current) {
        console.log('CaptureApp: Ignoring shortcut — transcription in progress');
        return;
      }

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

        // If orchestrator is loaded → raw PCM + local inference. Otherwise → MediaRecorder + IPC.
        // Don't check model name here — orchestrator only loads for WebGPU models, so isReady() is sufficient.
        const useRawPcm = orchestratorRef.current.isReady();
        rawPcmActiveRef.current = useRawPcm;
        console.log(`CaptureApp: Recording mode=${useRawPcm ? 'raw-pcm' : 'webm'}, orchestratorReady=${orchestratorRef.current.isReady()}, model=${selectedModelRef.current}`);
        const startFn = useRawPcm
          ? audioCapture.current.startRawRecording()
          : audioCapture.current.startRecording();

        startFn.catch((error: Error) => {
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
