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

export default function PopupApp() {
  const [transcription, setTranscription] = useState<TranscriptionData>({ text: '' });
  const [showSettings, setShowSettings] = useState(false);

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

  const modelDisplay = transcription.model?.split('/').pop() || 'base';
  const langDisplay = transcription.language?.toUpperCase() || 'EN';

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

      {/* Transcription area */}
      <TranscriptionDisplay
        text={transcription.text}
        processingTime={transcription.processingTime}
        onCopy={handleCopy}
      />

      {/* Status bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-border bg-muted/30 text-[10px]">
        <div className="flex items-center gap-2">
          <StatusIndicator />
          <span className="text-muted-foreground">{modelDisplay}</span>
          <span className="text-muted-foreground">{langDisplay}</span>
        </div>
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

      {/* Collapsible settings */}
      {showSettings && <SettingsPanel />}
    </div>
  );
}
