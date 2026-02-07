import React, { useState, useEffect } from 'react';

export default function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [transcription, setTranscription] = useState('');
  const [audioLevel, setAudioLevel] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    // Mock audio level updates during recording
    let levelInterval: NodeJS.Timeout;
    if (isRecording) {
      levelInterval = setInterval(() => {
        setAudioLevel(Math.random());
      }, 100);
    }
    
    return () => {
      if (levelInterval) clearInterval(levelInterval);
    };
  }, [isRecording]);

  useEffect(() => {
    // Duration counter
    let durationInterval: NodeJS.Timeout;
    if (isRecording) {
      durationInterval = setInterval(() => {
        setDuration(prev => prev + 1);
      }, 1000);
    } else {
      setDuration(0);
    }
    
    return () => {
      if (durationInterval) clearInterval(durationInterval);
    };
  }, [isRecording]);

  const handleStartRecording = async () => {
    setIsRecording(true);
    setTranscription('');
    
    // Mock transcription after 2 seconds
    setTimeout(() => {
      const mockTexts = [
        "Hello, this is a test of the MVP Echo transcription system.",
        "The quick brown fox jumps over the lazy dog.",
        "MVP Echo is working great with real-time transcription.",
        "This is a demonstration of voice to text conversion.",
        "The application is running smoothly on Windows 11."
      ];
      const randomText = mockTexts[Math.floor(Math.random() * mockTexts.length)];
      setTranscription(randomText);
    }, 2000);
  };

  const handleStopRecording = () => {
    setIsRecording(false);
    setAudioLevel(0);
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Audio visualizer bars
  const bars = Array.from({ length: 20 }, (_, i) => i);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-white">
      {/* Header */}
      <header className="border-b border-blue-200 p-6 bg-white shadow-sm">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <h1 className="text-3xl font-bold text-blue-600">MVP-Echo</h1>
          <div className="text-sm text-gray-600">Voice-to-Text Transcription</div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto p-6 space-y-6">
        {/* Recording Card */}
        <div className="bg-white rounded-xl border border-blue-200 p-8 shadow-lg hover:shadow-xl transition-shadow">
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-semibold text-gray-900">Voice Recording</h2>
              <div className="text-lg font-mono text-gray-600">
                {formatDuration(duration)}
                {isRecording && <span className="ml-2 text-blue-600 animate-pulse">●</span>}
              </div>
            </div>
            
            {/* Recording Controls */}
            <div className="flex items-center justify-center">
              <button
                onClick={isRecording ? handleStopRecording : handleStartRecording}
                className={`px-8 py-4 rounded-xl font-semibold text-lg transition-all duration-200 transform hover:scale-105 ${
                  isRecording 
                    ? 'bg-gray-600 text-white hover:bg-gray-700 shadow-lg' 
                    : 'bg-blue-600 text-white hover:bg-blue-700 shadow-xl shadow-blue-200'
                }`}
                style={{ minWidth: '200px' }}
              >
                {isRecording ? (
                  <span className="flex items-center justify-center gap-3">
                    <div className="w-4 h-4 bg-white rounded-sm"></div>
                    Stop Recording
                  </span>
                ) : (
                  <span className="flex items-center justify-center gap-3">
                    <div className="w-5 h-5 rounded-full bg-white"></div>
                    Start Recording
                  </span>
                )}
              </button>
            </div>
            
            {/* Audio Visualizer */}
            <div className="flex items-center justify-center gap-1 h-16 bg-blue-50 rounded-lg p-4">
              {bars.map((bar) => {
                const height = isRecording 
                  ? Math.max(8, audioLevel * Math.random() * 40 + Math.sin(Date.now() / 100 + bar) * 10)
                  : 8;
                
                return (
                  <div
                    key={bar}
                    className={`w-2 bg-blue-600 transition-all duration-100 rounded-sm ${
                      isRecording ? 'animate-pulse' : ''
                    }`}
                    style={{
                      height: `${height}px`,
                      opacity: isRecording ? 0.8 : 0.3
                    }}
                  />
                );
              })}
            </div>
          </div>
        </div>

        {/* Transcription Card */}
        <div className="bg-white rounded-xl border border-blue-200 p-8 shadow-lg">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-semibold text-gray-900">Transcription</h2>
              {isRecording && !transcription && (
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <div className="w-2 h-2 bg-blue-600 rounded-full animate-bounce"></div>
                  Processing...
                </div>
              )}
            </div>
            
            <div className="min-h-[200px] p-6 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
              {transcription ? (
                <p className="text-lg leading-relaxed text-gray-800">
                  {transcription}
                </p>
              ) : (
                <p className="text-gray-500 italic text-center py-16">
                  {isRecording 
                    ? "🎤 Listening and processing your speech..." 
                    : "Click 'Start Recording' to begin transcription"
                  }
                </p>
              )}
            </div>
            
            <div className="flex gap-3">
              <button 
                className={`px-4 py-2 text-sm border-2 rounded-lg transition-colors ${
                  transcription 
                    ? 'border-blue-300 hover:bg-blue-50 text-blue-700' 
                    : 'border-gray-300 text-gray-400 cursor-not-allowed'
                }`}
                disabled={!transcription}
              >
                📋 Copy Text
              </button>
              <button 
                className={`px-4 py-2 text-sm border-2 rounded-lg transition-colors ${
                  transcription 
                    ? 'border-blue-300 hover:bg-blue-50 text-blue-700' 
                    : 'border-gray-300 text-gray-400 cursor-not-allowed'
                }`}
                disabled={!transcription}
              >
                💾 Export TXT
              </button>
              <button 
                className={`px-4 py-2 text-sm border-2 rounded-lg transition-colors ${
                  transcription 
                    ? 'border-blue-300 hover:bg-blue-50 text-blue-700' 
                    : 'border-gray-300 text-gray-400 cursor-not-allowed'
                }`}
                disabled={!transcription}
              >
                📝 Export MD
              </button>
            </div>
          </div>
        </div>
      </main>

      {/* Status Bar */}
      <footer className="border-t border-blue-200 bg-blue-50 p-4 mt-8">
        <div className="max-w-4xl mx-auto flex items-center justify-between text-sm text-gray-600">
          <div className="flex items-center gap-4">
            <span>MVP-Echo v1.0.0</span>
            <span>•</span>
            <span>Engine: CPU Mode</span>
            <span>•</span>
            <span>Platform: Windows 11</span>
          </div>
          
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
            <span>Ready</span>
          </div>
        </div>
      </footer>
    </div>
  );
}