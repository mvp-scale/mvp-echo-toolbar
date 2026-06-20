import { useCallback, useEffect, useRef } from 'react';
import { AudioCapture } from './audio/AudioCapture';
import { playCompletionSound } from './audio/completion-sound';
import { playWarningSound } from './audio/warning-sound';
import { playStartSound } from './audio/start-sound';
import { InferenceOrchestrator } from './webgpu/inference-orchestrator';
import { setDiagEnabled, isDiagEnabled, sendDiag, saveDiagAudio, ilog } from './diag';

// ── Silence trimming (Parakeet is VAD-sensitive) ──
// threshold kept BELOW the silent-capture gate (0.005) so a quiet-but-real
// recording is never fully trimmed to nothing; generous pad preserves onsets.
function trimSilence(audio: Float32Array, threshold = 0.004): Float32Array {
  let start = 0, end = audio.length - 1;
  while (start < end && Math.abs(audio[start]) < threshold) start++;
  while (end > start && Math.abs(audio[end]) < threshold) end--;
  const pad = 3200; // 200ms at 16kHz
  const trimmed = audio.slice(Math.max(0, start - pad), Math.min(audio.length, end + pad + 1));
  // Never hand the model a near-empty buffer (a too-aggressive trim yields empty
  // transcriptions): if trimming nuked almost everything, use the original audio.
  if (trimmed.length < 4800 && audio.length >= 4800) return audio; // <0.3s → original
  return trimmed;
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
  const isStartingRef = useRef(false); // guards the async start window (re-entrancy)
  const selectedModelRef = useRef('');
  const selectedLanguageRef = useRef('');
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedRef = useRef(0);
  const orchestratorRef = useRef<InferenceOrchestrator>(new InferenceOrchestrator());
  const rawPcmActiveRef = useRef(false); // tracks which recording mode was used
  const requestGenRef = useRef(0);       // generation counter — ignores stale/late transcription results
  const initFailRef = useRef(0);         // consecutive orchestrator init failures (bounds re-init thrash)
  const lastInitAtRef = useRef(0);       // timestamp of last init attempt (re-init cooldown)
  const recCountRef = useRef(0);         // recording counter for diagnostics line numbering

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
      lastInitAtRef.current = Date.now();
      await orchestratorRef.current.initialize(backend, appVersion);
      initFailRef.current = 0; // success resets the failure/backoff counter
      console.log('CaptureApp: WebGPU orchestrator ready');

      const ipc = (window as any).electron?.ipcRenderer;
      if (ipc) ipc.invoke('webgpu:model-ready', true);
    } catch (e) {
      initFailRef.current += 1;
      console.warn(`CaptureApp: WebGPU orchestrator init failed (attempt ${initFailRef.current}):`, e);
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

      // Apply mic readiness mode from app-config (separate from cloud config).
      try {
        const appConfig = await ipc.invoke('app-config:get');
        if (appConfig?.micReadinessMode) {
          audioCapture.current.setMicReleaseMode(appConfig.micReadinessMode);
          console.log(`CaptureApp: micReadinessMode=${appConfig.micReadinessMode}`);
        }
      } catch (e) {
        console.warn('CaptureApp: Failed to load app-config:', e);
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

    // Forward renderer console to main, but keep it QUIET by default: routine
    // console.log only fires when diagnostics are enabled (--diag). Errors and
    // warnings always go through. Per-recording detail goes to the dedicated
    // diagnostics file via sendDiag(), not the console.
    const ipc = (window as any).electron?.ipcRenderer;
    const origLog = console.log;
    const origError = console.error;
    const origWarn = console.warn;
    console.log = (...args: any[]) => {
      if (!isDiagEnabled()) return; // quiet unless diagnostics on
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

    // Diagnostics wiring: learn whether deep capture is on (launch flag), and
    // stream async source/device events to the diagnostics file when it is.
    ipc?.invoke('diag:enabled').then((v: boolean) => setDiagEnabled(!!v)).catch(() => {});
    audioCapture.current.onTrackEvent = (kind: string) => sendDiag(`track-event: ${kind}`);
    // Authoritative "talk now" cue: fires only when the mic is CONFIRMED live
    // (real frames flowing + track unmuted), not on keypress. The on-press color
    // flip just means "press received"; THIS tone is the signal to start speaking,
    // so early speech no longer lands in the device's unmute/warm-up dead window.
    audioCapture.current.onCaptureReady = (latencyMs: number) => {
      if (!isRecordingRef.current) return; // ignore a late fire after stop/reset
      playStartSound();
      api.updateTrayState('recording'); // (re)assert the live color now that capture is real
      ilog(`● live in ${latencyMs}ms`);
      sendDiag(`ready: keypress→live ${latencyMs}ms`);
    };
    const onDeviceChange = () => sendDiag('devicechange — system device list changed');
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);

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
      isStartingRef.current = false;
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

      // Claim this run. The 60s safety timeout below bumps the generation so any
      // result that resolves AFTER the timeout is recognized as stale and dropped
      // (instead of copying old text to the clipboard / flipping the tray on a
      // run the user has already given up on).
      const myGen = ++requestGenRef.current;
      const isStale = () => myGen !== requestGenRef.current;

      // Safety timeout: the renderer is the authority. If processing exceeds 60s,
      // invalidate this run and HARD-CANCEL the in-flight worker (terminate) so it
      // can't corrupt the next transcription. The next WebGPU recording re-inits
      // the model from the local cache (load+warmup, no re-download).
      const safetyTimeout = setTimeout(() => {
        console.error('CaptureApp: SAFETY TIMEOUT — processing exceeded 60s, aborting + resetting');
        requestGenRef.current++; // supersede this run
        if (wasRawPcm) orchestratorRef.current.abort();
        resetState(electronAPI);
      }, 60000);

      try {
        if (wasRawPcm && orchestratorRef.current.isReady()) {
          // ── WebGPU LOCAL PATH ──
          console.log('CaptureApp: Stopping raw PCM capture...');
          // Re-read mic-readiness at stop time so a Settings change applies
          // without an app restart (the warm/release decision is made here).
          try {
            const cfgIpc = (window as any).electron?.ipcRenderer;
            const ac = cfgIpc ? await cfgIpc.invoke('app-config:get') : null;
            if (ac?.micReadinessMode) audioCapture.current.setMicReleaseMode(ac.micReadinessMode);
          } catch { /* ok */ }
          const { pcm, sampleRate, peak, rms, diag } = await audioCapture.current.stopRawRecording();
          const recordedSec = pcm.length / sampleRate;
          console.log(`CaptureApp: Got ${pcm.length} samples (${recordedSec.toFixed(1)}s), peak=${peak.toFixed(4)}, rms=${rms.toFixed(4)}`);

          // NOTE: no pre-transcribe RMS/peak discard. AutoGain (on) keeps the
          // captured level in range, so we transcribe every recording rather than
          // throwing away quiet-but-valid audio (that gate caused false-positive
          // drops and a cold-rebuild loop). rms is logged above for diagnostics.

          if (pcm.length > 0) {
            const trimmed = trimSilence(pcm);
            console.log(`CaptureApp: Trimmed to ${trimmed.length} samples, sending to parakeet.js`);
            let result = await orchestratorRef.current.transcribe(trimmed, sampleRate);
            if (isStale()) { console.warn('CaptureApp: stale WebGPU result ignored (run superseded)'); return; }
            // Retry ONCE on an empty result for clearly-real audio (we already
            // passed the silent-capture gate). Targets the intermittent warm-worker
            // blank; the worker also resets its scratch cache before each call.
            if (!result.text?.trim()) {
              console.warn('CaptureApp: empty result for real audio — retrying once');
              result = await orchestratorRef.current.transcribe(trimSilence(pcm), sampleRate);
              if (isStale()) { console.warn('CaptureApp: stale retry result ignored'); return; }
            }
            console.log(`CaptureApp: Result: "${result.text}" (${result.processingTime.toFixed(0)}ms)`);

            // ── Diagnostics fingerprint: one line per recording → diag file (--diag) ──
            sendDiag(
              `#${++recCountRef.current} dev=${diag.dev}·${diag.hash}${diag.chg ? ' CHG' : ''}` +
              ` gap=${diag.gapS}s age=${diag.ageS}s rate=${diag.rate} agc=${diag.agc} ns=${diag.ns} ec=${diag.ec}` +
              ` ready=${diag.ready} muted=${diag.muted} ctx=${diag.ctx}/${diag.ctxRate} refs=${diag.refs ? 'ok' : 'LOST'} msgs=${diag.msgs}` +
              ` samples=${pcm.length}(${recordedSec.toFixed(1)}s) peak=${peak.toFixed(3)} rms=${rms.toFixed(4)}` +
              ` result=${result.text?.trim() ? result.text.trim().length + 'ch' : 'EMPTY'} proc=${result.processingTime.toFixed(0)}ms`
            );
            // Persist the exact captured audio (full, pre-trim) for playback —
            // the filename flags the EMPTY ones so they're easy to find & listen to.
            saveDiagAudio(`rec-${String(recCountRef.current).padStart(3, '0')}-rms${rms.toFixed(4)}-${result.text?.trim() ? 'ok' : 'EMPTY'}.wav`, pcm, sampleRate);

            if (result.text?.trim()) {
              // Ring the completion bell ONLY when the clipboard write is
              // verified — the bell means "it's on your clipboard", not "done".
              const copied = await electronAPI.copyToClipboard(result.text);
              if (copied?.success) {
                playCompletionSound();
                electronAPI.updateTrayState('done');
                ilog(`✓ ${result.text.trim().length} chars · rec ${recordedSec.toFixed(1)}s · proc ${(result.processingTime / 1000).toFixed(1)}s · copied`);
              } else {
                console.error('CaptureApp: clipboard write NOT verified — no bell');
                playWarningSound(); // distinct cue: transcribed but not copied
                electronAPI.updateTrayState('error');
                setTimeout(() => electronAPI.updateTrayState('ready'), 3000);
                ilog(`⚠ ${result.text.trim().length} chars · rec ${recordedSec.toFixed(1)}s · clipboard write FAILED`);
              }
              // Store regardless so the popup has the text for manual copy.
              electronAPI.webgpuStoreTranscription({
                text: result.text,
                processingTime: result.processingTime,
                engine: `webgpu (${selectedModelRef.current})`,
                model: selectedModelRef.current,
                language: 'en',
              });
            } else {
              ilog(`∅ no speech · rec ${recordedSec.toFixed(1)}s`);
              electronAPI.updateTrayState('ready');
            }
          } else {
            console.warn('CaptureApp: Empty audio');
            ilog('∅ no audio captured');
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
            if (isStale()) { console.warn('CaptureApp: stale transcription result ignored (run superseded)'); return; }

            if (result.success === false) {
              console.error('CaptureApp: Transcription failed:', result.error);
              electronAPI.updateTrayState('error');
              setTimeout(() => electronAPI.updateTrayState('ready'), 3000);
            } else if (result.text?.trim()) {
              // Bell only on a verified clipboard write (see WebGPU path above).
              const copied = await electronAPI.copyToClipboard(result.text);
              if (copied?.success) {
                playCompletionSound();
                electronAPI.updateTrayState('done');
              } else {
                console.error('CaptureApp: clipboard write NOT verified — no bell');
                playWarningSound();
                electronAPI.updateTrayState('error');
                setTimeout(() => electronAPI.updateTrayState('ready'), 3000);
              }
            } else {
              electronAPI.updateTrayState('ready');
            }
          } else {
            electronAPI.updateTrayState('ready');
          }
        }
      } catch (error: any) {
        console.error('CaptureApp: performStop error:', error);
        // A worker aborted by the 60s timeout rejects later at its own 120s
        // timeout — by then this run is stale and may have been replaced by a
        // newer recording, so don't stomp its tray state.
        if (!isStale()) {
          electronAPI.updateTrayState('error');
          setTimeout(() => electronAPI.updateTrayState('ready'), 3000);
        }
      } finally {
        clearTimeout(safetyTimeout);
        // Only clear the flags if THIS run is still the current one. If a 60s
        // timeout already superseded us (and possibly a new recording started),
        // leave the newer run's flags alone.
        if (!isStale()) {
          isProcessingRef.current = false;
          rawPcmActiveRef.current = false;
        }
        console.log('CaptureApp: performStop complete, state=ready');
      }
    };

    const unsubscribe = api.onGlobalShortcutToggle(() => {
      console.log('CaptureApp: Global shortcut toggle received');

      // Ignore presses while processing OR while a start is still in flight.
      // The start guard is the fix for the re-entrancy race: a second press
      // landing after the 500ms main-process debounce but before the async
      // getUserMedia/worklet setup resolves would otherwise be read as a "stop"
      // of a recording that never finished starting — producing an empty
      // transcription and orphaning a live mic stream + AudioContext.
      if (isProcessingRef.current || isStartingRef.current) {
        console.log('CaptureApp: Ignoring shortcut — busy (processing or start in flight)');
        return;
      }

      const currentlyRecording = isRecordingRef.current;

      if (currentlyRecording) {
        // ── Stop Recording (manual) ──
        performStop(api);
      } else {
        // If a WebGPU model is selected but its orchestrator isn't ready yet,
        // don't silently downgrade to the webm/IPC path — ignore the press with
        // a brief tray hint so the user knows the model is still loading. If the
        // orchestrator is idle (e.g. torn down after a timeout-abort or a lost
        // GPU device), kick off a fresh init so the NEXT press can record —
        // bounded lazy recovery, no retry loop.
        if (selectedModelRef.current.startsWith('webgpu-') && !orchestratorRef.current.isReady()) {
          console.log('CaptureApp: Ignoring shortcut — WebGPU model not ready');
          if (!orchestratorRef.current.isLoading()) {
            // Bounded recovery: re-init at most once per 15s and give up after 3
            // consecutive failures, so a reload that keeps failing on a memory-
            // constrained machine can't thrash (the "memory tried-and-reused" loop).
            const sinceLast = Date.now() - lastInitAtRef.current;
            if (initFailRef.current >= 3) {
              console.error('CaptureApp: orchestrator init failed 3× — not auto-retrying; app restart needed');
            } else if (sinceLast > 15000) {
              console.log('CaptureApp: orchestrator idle — re-initializing');
              initWebGpuOrchestrator();
            } else {
              console.log(`CaptureApp: skipping re-init (cooldown, ${Math.round(sinceLast / 1000)}s since last attempt)`);
            }
          }
          api.updateTrayState('error');
          setTimeout(() => api.updateTrayState('ready'), 1500);
          return;
        }

        // ── Start Recording ──
        console.log('CaptureApp: Starting recording');
        isStartingRef.current = true; // in-flight guard ON (cleared in .finally below)
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

        // Start watchdog: if the start never settles (e.g. getUserMedia hangs on
        // a flaky audio device after long idle), force a reset so the in-flight
        // guard can't permanently wedge the toggle. 25s tolerates a slow cold
        // start (permission prompt / device wake) without stomping a real one.
        const startWatchdog = setTimeout(() => {
          if (isStartingRef.current) {
            console.error('CaptureApp: START WATCHDOG — start did not complete in 25s, forcing reset');
            resetState(api);
          }
        }, 25000);

        startFn
          .catch((error: Error) => {
            console.error('CaptureApp: Start recording failed:', error);
            isRecordingRef.current = false;
            rawPcmActiveRef.current = false;
            clearCountdown();
            audioCapture.current.cleanup(); // tear down any half-opened stream/context
            api.updateTrayState('error');
            setTimeout(() => api.updateTrayState('ready'), 3000);
          })
          .finally(() => {
            // Clear the guard + watchdog whether start succeeded or failed — no lockout.
            clearTimeout(startWatchdog);
            isStartingRef.current = false;
            // If a watchdog/reset fired while the mic was still opening, the
            // just-acquired stream is now orphaned (isRecording was cleared) —
            // tear it down so it can't leak a live mic.
            if (!isRecordingRef.current) audioCapture.current.cleanup();
          });
      }
    });

    // Cleanup on unmount
    return () => {
      // Restore original console.* so a reload/remount can't stack wrappers
      // (each stacked wrapper multiplies the IPC log forwarding).
      console.log = origLog;
      console.error = origError;
      console.warn = origWarn;
      navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
      audioCapture.current.onTrackEvent = undefined;
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
