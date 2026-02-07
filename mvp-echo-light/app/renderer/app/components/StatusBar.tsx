import React from 'react';

interface StatusBarProps {
  systemInfo: any;
}

export default function StatusBar({ systemInfo }: StatusBarProps) {
  return (
    <footer className="border-t border-border bg-muted/30 p-3">
      <div className="container max-w-4xl mx-auto flex items-center justify-between text-xs text-muted-foreground">
        <div className="flex items-center gap-4">
          <span>MVP-Echo v{systemInfo?.version || '1.0.0'}</span>
          <span>•</span>
          <span>Engine: {systemInfo?.gpuMode || 'CPU'} Mode</span>
          <span>•</span>
          <span>Platform: {systemInfo?.platform || 'Windows'}</span>
        </div>
        
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-green-500 rounded-full"></div>
          <span>Ready</span>
        </div>
      </div>
    </footer>
  );
}