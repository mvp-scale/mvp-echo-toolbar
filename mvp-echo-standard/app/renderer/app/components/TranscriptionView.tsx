import React from 'react';

interface TranscriptionViewProps {
  text: string;
  isProcessing: boolean;
}

export default function TranscriptionView({ text, isProcessing }: TranscriptionViewProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Transcription</h2>
        {isProcessing && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <div className="w-2 h-2 bg-primary rounded-full animate-pulse"></div>
            Processing...
          </div>
        )}
      </div>
      
      <div className="min-h-[200px] p-4 bg-muted/50 rounded-lg border">
        {text ? (
          <p className="text-sm leading-relaxed whitespace-pre-wrap">
            {text}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground italic">
            {isProcessing 
              ? "Listening and processing your speech..." 
              : "Click 'Start Recording' to begin transcription"
            }
          </p>
        )}
      </div>
      
      <div className="flex gap-2">
        <button 
          className="px-4 py-2 text-sm border rounded-lg hover:bg-muted/50 transition-colors"
          disabled={!text}
        >
          📋 Copy Text
        </button>
        <button 
          className="px-4 py-2 text-sm border rounded-lg hover:bg-muted/50 transition-colors"
          disabled={!text}
        >
          💾 Export TXT
        </button>
        <button 
          className="px-4 py-2 text-sm border rounded-lg hover:bg-muted/50 transition-colors"
          disabled={!text}
        >
          📝 Export MD
        </button>
      </div>
    </div>
  );
}