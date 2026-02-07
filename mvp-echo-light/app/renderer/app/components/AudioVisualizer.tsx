import React from 'react';

interface AudioVisualizerProps {
  audioLevel: number;
  isRecording: boolean;
}

export default function AudioVisualizer({ audioLevel, isRecording }: AudioVisualizerProps) {
  // Generate 20 bars for visualization
  const bars = Array.from({ length: 20 }, (_, i) => i);

  return (
    <div className="flex items-center justify-center gap-1 h-16 bg-muted/30 rounded-lg p-4">
      {bars.map((bar) => {
        const height = isRecording 
          ? Math.max(8, audioLevel * Math.random() * 40 + Math.sin(Date.now() / 100 + bar) * 10)
          : 8;
        
        return (
          <div
            key={bar}
            className={`w-2 bg-primary transition-all duration-100 rounded-sm ${
              isRecording ? 'recording-pulse' : ''
            }`}
            style={{
              height: `${height}px`,
              opacity: isRecording ? 0.8 : 0.3
            }}
          />
        );
      })}
    </div>
  );
}