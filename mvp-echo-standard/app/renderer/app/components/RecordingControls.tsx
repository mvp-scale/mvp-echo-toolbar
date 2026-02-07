import React from 'react';

interface RecordingControlsProps {
  isRecording: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
}

export default function RecordingControls({
  isRecording,
  onStartRecording,
  onStopRecording
}: RecordingControlsProps) {
  return (
    <div className="flex items-center justify-center gap-4">
      <button
        onClick={isRecording ? onStopRecording : onStartRecording}
        className={isRecording ? "mvp-button-secondary" : "mvp-button-primary"}
        style={{ minWidth: '180px' }}
      >
        <div className="flex items-center justify-center gap-2">
          {isRecording ? (
            <>
              <div className="w-4 h-4 bg-white rounded-sm"></div>
              Stop Recording
            </>
          ) : (
            <>
              <div className="w-4 h-4 rounded-full bg-white"></div>
              Start Recording
            </>
          )}
        </div>
      </button>
    </div>
  );
}