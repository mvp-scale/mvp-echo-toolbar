import { useState, useEffect, useCallback } from 'react';
import TranscriptionDisplay from './components/TranscriptionDisplay';
import SettingsPanel from './components/SettingsPanel';
import StatusIndicator from './components/StatusIndicator';

interface TranscriptionData {
  text: string;
  processingTime?: number;
  engine?: string;
  language?: string;
  model?: string;
}

interface CountdownData {
  active: boolean;
  remaining: number;
  total: number;
}

/** Detect if running inside Electron */
const isElectron = typeof (window as any).electronAPI !== 'undefined' &&
  navigator.userAgent.toLowerCase().includes('electron');

/**
 * CountdownDisplay - Large countdown timer shown when recording approaches the limit
 */
function CountdownDisplay({ remaining }: { remaining: number }) {
  const seconds = remaining % 60;
  const timeStr = `0:${seconds.toString().padStart(2, '0')}`;

  // Intensity ramps from 0.5 → 1.0 as remaining goes 60 → 0
  const intensity = Math.max(0, Math.min(1, 1 - remaining / 60));
  // Opacity for the text: starts at 60% red, ends at 100%
  const textOpacity = 0.6 + intensity * 0.4;
  // Glow gets stronger as time runs out
  const glowSize = Math.round(4 + intensity * 16);

  return (
    <div className="flex flex-col items-center justify-center h-full px-6 gap-3">
      {/* Countdown timer — red, brightening */}
      <div
        className="text-6xl font-mono font-bold tabular-nums transition-all duration-1000"
        style={{
          color: `rgba(239, 68, 68, ${textOpacity})`,
          textShadow: `0 0 ${glowSize}px rgba(239, 68, 68, ${intensity * 0.5})`,
        }}
      >
        {timeStr}
      </div>

      {/* Label */}
      <div
        className="text-sm font-medium transition-all duration-1000"
        style={{ color: `rgba(239, 68, 68, ${textOpacity * 0.8})` }}
      >
        {remaining <= 10 ? 'Recording will auto-stop!' : 'Recording time remaining'}
      </div>

      {/* Progress bar — red, filling up */}
      <div className="w-full h-2 bg-muted rounded-full overflow-hidden mt-2">
        <div
          className="h-full rounded-full bg-red-500 transition-all duration-1000 ease-linear"
          style={{ width: `${intensity * 100}%`, opacity: 0.6 + intensity * 0.4 }}
        />
      </div>
    </div>
  );
}

export default function PopupApp() {
  const [transcription, setTranscription] = useState<TranscriptionData>({ text: '' });
  const [showSettings, setShowSettings] = useState(false);
  const [countdown, setCountdown] = useState<CountdownData | null>(null);

  // Load last transcription on mount
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api) return;

    api.getLastTranscription().then((data: TranscriptionData) => {
      if (data) {
        setTranscription(data);
      }
    });

    // Listen for live updates
    const unsubscribe = api.onTranscriptionUpdated((data: TranscriptionData) => {
      setTranscription(data);
    });

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, []);

  // Listen for countdown updates (Electron only)
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api || !api.onCountdownUpdate) return;

    const unsubscribe = api.onCountdownUpdate((data: CountdownData) => {
      if (data.active) {
        setCountdown(data);
      } else {
        setCountdown(null);
      }
    });

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, []);

  // Browser auto-simulation: cycle through countdown for styling preview
  useEffect(() => {
    if (isElectron) return;

    let remaining = 60;
    setCountdown({ active: true, remaining, total: 600 });

    const timer = setInterval(() => {
      remaining -= 1;
      if (remaining < 0) {
        remaining = 60;
      }
      setCountdown({ active: true, remaining, total: 600 });
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  const handleCopy = useCallback(async () => {
    const api = (window as any).electronAPI;
    if (api && transcription.text) {
      await api.copyToClipboard(transcription.text);
    }
  }, [transcription.text]);

  const handleClose = useCallback(() => {
    const api = (window as any).electronAPI;
    if (api) {
      api.hidePopup();
    }
  }, []);

  const modelDisplay = transcription.model?.split('/').pop() || '';
  const langDisplay = '';

  const handleDebug = useCallback(() => {
    (window as any).electron?.ipcRenderer?.invoke('debug:open-devtools').catch(() => {});
  }, []);

  return (
    <div className="w-full h-full bg-background text-foreground rounded-lg border border-border shadow-xl overflow-hidden flex flex-col select-none">
      {/* Title bar (draggable) */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30 draggable">
        <div className="flex items-center gap-2 non-draggable">
          <div className="w-4 h-4 rounded bg-primary flex items-center justify-center">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="text-primary-foreground">
              <path d="M12 2C10.9 2 10 2.9 10 4V12C10 13.1 10.9 14 12 14C13.1 14 14 13.1 14 12V4C14 2.9 13.1 2 12 2Z"/>
              <path d="M18 12C18 15.3 15.3 18 12 18C8.7 18 6 15.3 6 12H4C4 16.4 7.6 20 12 20C16.4 20 20 16.4 20 12H18Z"/>
            </svg>
          </div>
          <span className="text-xs font-semibold">MVP-Echo Toolbar</span>
        </div>
        <button
          onClick={handleClose}
          className="non-draggable w-5 h-5 flex items-center justify-center rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
            <line x1="1" y1="1" x2="9" y2="9" />
            <line x1="9" y1="1" x2="1" y2="9" />
          </svg>
        </button>
      </div>

      {/* Scrollable content area — countdown replaces transcription when active */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {countdown?.active ? (
          <CountdownDisplay remaining={countdown.remaining} />
        ) : (
          <>
            <TranscriptionDisplay
              text={transcription.text}
              processingTime={transcription.processingTime}
              onCopy={handleCopy}
            />

            {/* Collapsible settings */}
            {showSettings && <SettingsPanel />}
          </>
        )}
      </div>

      {/* Status bar — always pinned to bottom */}
      <div className="flex-shrink-0 flex items-center justify-between px-3 py-1.5 border-t border-border bg-muted/30 text-[10px]">
        <div className="flex items-center gap-2">
          <StatusIndicator />
          {modelDisplay && <span className="text-muted-foreground">{modelDisplay}</span>}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleDebug}
            className="px-2 py-0.5 rounded text-[9px] font-medium transition-all cursor-pointer border text-muted-foreground hover:text-foreground hover:bg-muted border-transparent"
          >
            Debug
          </button>
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`px-2 py-0.5 rounded text-[9px] font-medium transition-all cursor-pointer border ${
              showSettings
                ? 'bg-slate-200 text-slate-900 border-slate-300'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted border-transparent'
            }`}
          >
            Settings
          </button>
        </div>
      </div>
    </div>
  );
}
