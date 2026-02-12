import React, { useState } from 'react';

interface WelcomeScreenProps {
  onDismiss: () => void;
  version?: string;
}

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  onDismiss,
  version = '3.0.0'
}) => {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  const handleGetStarted = async () => {
    if (dontShowAgain) {
      try {
        await (window as any).electronAPI.setWelcomePreference({ dismissedVersion: version });
      } catch (err) {
        console.warn('Failed to save welcome preference:', err);
      }
    }
    onDismiss();
  };

  return (
    <div className="h-screen flex items-center justify-center bg-background">
      <div className="w-[500px] bg-background border border-border rounded-2xl shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="px-8 pt-8 pb-4 text-center">
          {/* Rounded squircle icon matching tray style */}
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-[16px] mb-4" style={{ backgroundColor: '#4285f4' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M12 2C10.9 2 10 2.9 10 4V12C10 13.1 10.9 14 12 14C13.1 14 14 13.1 14 12V4C14 2.9 13.1 2 12 2Z" fill="white"/>
              <path d="M18 12C18 15.3 15.3 18 12 18C8.7 18 6 15.3 6 12H4C4 16.4 7.6 20 12 20C16.4 20 20 16.4 20 12H18Z" fill="white"/>
              <path d="M11 21V23H13V21H11Z" fill="white"/>
            </svg>
          </div>
          <h1 className="text-xl font-bold text-foreground">MVP-Echo Toolbar</h1>
          <p className="text-sm text-muted-foreground mt-1">v{version}</p>
        </div>

        <div className="px-8 pb-2">
          <div className="border-t border-border" />
        </div>

        {/* How it works */}
        <div className="px-8 py-4">
          <p className="text-sm text-muted-foreground text-center mb-5">
            A microphone icon has been added to your notification area (system tray).
            You may need to drag it from the overflow into the visible section.
            Click it to access settings and models.
          </p>

          <div className="grid grid-cols-3 gap-3">
            <div className="bg-muted/30 rounded-lg p-3 text-center border border-border/50">
              <div className="text-lg mb-1.5">🎙️</div>
              <p className="text-xs font-semibold text-foreground mb-1">Record</p>
              <p className="text-[10px] text-muted-foreground leading-tight">
                Ctrl+Alt, tap Z to start and stop
              </p>
            </div>
            <div className="bg-muted/30 rounded-lg p-3 text-center border border-border/50">
              <div className="text-lg mb-1.5">📋</div>
              <p className="text-xs font-semibold text-foreground mb-1">Copy</p>
              <p className="text-[10px] text-muted-foreground leading-tight">
                Text auto-copied to clipboard
              </p>
            </div>
            <div className="bg-muted/30 rounded-2xl p-3 text-center border border-border/50">
              <div className="flex justify-center gap-1.5 mb-1.5">
                {[
                  { color: '#4285f4', label: 'Ready' },
                  { color: '#ea4335', label: 'Rec' },
                  { color: '#f57c00', label: 'Busy' },
                  { color: '#34a853', label: 'Done' },
                ].map(({ color, label }) => (
                  <div key={color} className="flex flex-col items-center gap-0.5">
                    <svg width="22" height="22" viewBox="0 0 24 24">
                      <rect x="0" y="0" width="24" height="24" rx="6" fill={color} />
                      <path d="M12 5C10.9 5 10 5.9 10 7V12C10 13.1 10.9 14 12 14C13.1 14 14 13.1 14 12V7C14 5.9 13.1 5 12 5Z" fill="white"/>
                      <path d="M16.5 12C16.5 14.5 14.5 16.5 12 16.5C9.5 16.5 7.5 14.5 7.5 12H6C6 15.1 8.5 17.6 11.5 18V19.5H12.5V18C15.5 17.6 18 15.1 18 12H16.5Z" fill="white"/>
                    </svg>
                    <span className="text-[8px] text-muted-foreground">{label}</span>
                  </div>
                ))}
              </div>
              <p className="text-xs font-semibold text-foreground mb-1">Tray Icon</p>
              <p className="text-[10px] text-muted-foreground leading-tight">
                Changes color with status
              </p>
            </div>
          </div>
        </div>

        {/* What's New */}
        <div className="px-8 py-3">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            What's New
          </h3>
          <ul className="space-y-1.5">
            <li className="flex items-center gap-2 text-sm text-foreground">
              <span className="w-1 h-1 rounded-full bg-primary flex-shrink-0" />
              Industry-leading GPU transcription — under 1 second
            </li>
            <li className="flex items-center gap-2 text-sm text-foreground">
              <span className="w-1 h-1 rounded-full bg-primary flex-shrink-0" />
              Switch between English and Multilingual models
            </li>
            <li className="flex items-center gap-2 text-sm text-foreground">
              <span className="w-1 h-1 rounded-full bg-primary flex-shrink-0" />
              Offline CPU mode — no internet required
            </li>
          </ul>
        </div>

        {/* Footer */}
        <div className="px-8 pt-3 pb-6 flex items-center justify-between">
          <label className="flex items-center gap-2 cursor-pointer select-none group">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-border text-primary focus:ring-primary/50 cursor-pointer"
            />
            <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors">
              Don't show this again
            </span>
          </label>

          <button
            onClick={handleGetStarted}
            className="px-5 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-offset-2 focus:ring-offset-background"
          >
            Get Started
          </button>
        </div>
      </div>
    </div>
  );
};
