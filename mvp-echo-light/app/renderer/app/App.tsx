import React, { useState, useEffect, useRef, useCallback, useReducer } from 'react';
import OceanVisualizer from './components/OceanVisualizer';
import { SetupProgress } from './components/SetupProgress';
import { EngineSelector } from './components/EngineSelector';

// Soft completion sound - gentle synthesized chime
const playCompletionSound = () => {
  try {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();

    // Create a soft, pleasant tone
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    // Soft sine wave at a pleasant frequency (C6 note - 1047 Hz, very gentle)
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, audioContext.currentTime); // A5 note

    // Very soft volume with gentle fade out
    gainNode.gain.setValueAtTime(0.08, audioContext.currentTime); // Start very soft
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.5); // Fade out over 500ms

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.5);

    // Clean up
    oscillator.onended = () => audioContext.close();
  } catch (e) {
    console.warn('Could not play completion sound:', e);
  }
};

// Audio recording functionality (renderer process)
class AudioCapture {
  private mediaRecorder?: MediaRecorder;
  private audioChunks: Blob[] = [];
  private stream?: MediaStream;
  private audioContext?: AudioContext;
  private analyser?: AnalyserNode;
  private dataArray?: Uint8Array;
  private onAudioLevel?: (level: number) => void;
  private animationId?: number;
  private sourceNode?: MediaStreamAudioSourceNode;
  
  getStream(): MediaStream | undefined {
    return this.stream;
  }

  async startRecording(onAudioLevel?: (level: number) => void): Promise<void> {
    this.onAudioLevel = onAudioLevel;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.mediaRecorder = new MediaRecorder(this.stream);
    this.audioChunks = [];
    
    // Set up Web Audio API for real-time audio level detection
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    
    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
    this.sourceNode.connect(this.analyser);
    
    // Start monitoring audio levels
    this.monitorAudioLevel();
    
    this.mediaRecorder.ondataavailable = (event) => {
      this.audioChunks.push(event.data);
    };
    
    this.mediaRecorder.start();
  }
  
  private monitorAudioLevel(): void {
    if (!this.analyser || !this.dataArray) return;
    
    const updateLevel = () => {
      if (!this.analyser || !this.dataArray || !this.onAudioLevel) return;
      
      this.analyser.getByteFrequencyData(this.dataArray);
      
      // Calculate RMS (Root Mean Square) for audio level
      let sum = 0;
      for (let i = 0; i < this.dataArray.length; i++) {
        sum += this.dataArray[i] * this.dataArray[i];
      }
      const rms = Math.sqrt(sum / this.dataArray.length);
      const level = rms / 255; // Normalize to 0-1
      
      this.onAudioLevel(level);
      
      if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
        this.animationId = requestAnimationFrame(updateLevel);
      }
    };
    
    updateLevel();
  }
  
  async stopRecording(): Promise<ArrayBuffer> {
    return new Promise((resolve) => {
      if (!this.mediaRecorder) {
        this.cleanup(); // Cleanup even if no recorder
        resolve(new ArrayBuffer(0));
        return;
      }
      
      this.mediaRecorder.onstop = async () => {
        const blob = new Blob(this.audioChunks, { type: 'audio/webm' });
        const arrayBuffer = await blob.arrayBuffer();
        // Cleanup AFTER we've processed the audio
        this.cleanup();
        resolve(arrayBuffer);
      };
      
      this.mediaRecorder.stop();
    });
  }
  
  cleanup(): void {
    // Cancel any pending animation frames
    if (this.animationId !== undefined) {
      cancelAnimationFrame(this.animationId);
      this.animationId = undefined;
    }
    
    // Disconnect and clear source node first
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = undefined;
    }
    
    // Stop all tracks immediately
    if (this.stream) {
      this.stream.getTracks().forEach(track => {
        track.stop();
        console.log('MVP-Echo: Stopped track:', track.kind, track.label);
      });
      this.stream = undefined;
    }
    
    // Close audio context and wait for it to close
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().then(() => {
        console.log('MVP-Echo: AudioContext closed');
      }).catch(err => {
        console.warn('MVP-Echo: AudioContext close failed:', err);
      });
      this.audioContext = undefined;
    }
    
    // Clear all references
    this.mediaRecorder = undefined;
    this.analyser = undefined;
    this.dataArray = undefined;
    this.onAudioLevel = undefined;
    this.audioChunks = [];
    
    console.log('MVP-Echo: AudioCapture cleanup complete');
  }
}

export default function App() {
  // Removed excessive logging to prevent console spam
  
  // Check if running in Electron
  const isElectron = typeof (window as any).electronAPI !== 'undefined';
  
  // Setup state - Light version doesn't need setup wizard
  const [isInitialized, setIsInitialized] = useState(true);
  const [showSetup, setShowSetup] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  
  // Debug: Log when component mounts and cleanup on unmount
  useEffect(() => {
    console.log('MVP-Echo: App component mounted successfully');
    console.log('MVP-Echo: Running in Electron:', isElectron);
    
    // Also cleanup on window unload/refresh
    const handleBeforeUnload = () => {
      if (audioCapture.current) {
        audioCapture.current.cleanup();
      }
    };
    
    window.addEventListener('beforeunload', handleBeforeUnload);
    
    // Cleanup function to ensure microphone is stopped on unmount
    return () => {
      console.log('MVP-Echo: App component unmounting, cleaning up...');
      handleBeforeUnload();
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);
  

  const [systemInfo, setSystemInfo] = useState<any>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [transcription, setTranscription] = useState('');
  const [audioLevel, setAudioLevel] = useState(0);
  const [processingStatus, setProcessingStatus] = useState('');
  const [privacyMode, setPrivacyMode] = useState(false);
  const [privacyReminder, setPrivacyReminder] = useState(false);
  const [lastProcessingTime, setLastProcessingTime] = useState<number | null>(null);

  // Cloud settings state
  const [endpointUrl, setEndpointUrl] = useState('http://192.168.1.10:20300/v1/audio/transcriptions');
  const [apiKey, setApiKey] = useState('');
  const [selectedModel, setSelectedModel] = useState('Systran/faster-whisper-base');
  const [selectedLanguage, setSelectedLanguage] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'testing' | 'connected'>('disconnected');
  const [currentModelDisplay, setCurrentModelDisplay] = useState('base');
  const [detectedLanguage, setDetectedLanguage] = useState<string | null>(null);
  const [serverDevice, setServerDevice] = useState('CPU');
  const [configLoaded, setConfigLoaded] = useState(false); // Track if config has been loaded from disk
  const audioCapture = useRef(new AudioCapture());
  const isRecordingRef = useRef(false);
  const privacyModeRef = useRef(false);
  const selectedModelRef = useRef(selectedModel);
  const selectedLanguageRef = useRef(selectedLanguage);

  // Sync refs when state changes
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    privacyModeRef.current = privacyMode;
  }, [privacyMode]);

  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);

  useEffect(() => {
    selectedLanguageRef.current = selectedLanguage;
  }, [selectedLanguage]);


  const handleStartRecording = useCallback(async (source = 'unknown') => {
    if (isRecording) return; // Simple state check
    
    console.log(`🎤 Starting recording from: ${source}`);
    setIsRecording(true); // Update state immediately
    setTranscription('');
    setProcessingStatus('Starting...');
    
    try {
      await audioCapture.current.startRecording(setAudioLevel);
      setProcessingStatus('Recording...');
      await (window as any).electronAPI.startRecording(source);
    } catch (error) {
      console.error('Start recording failed:', error);
      setIsRecording(false);
      setProcessingStatus('Failed to start');
    }
  }, [isRecording]);

  const handleStopRecording = useCallback(async (source = 'unknown') => {
    if (!isRecording) return; // Simple state check
    
    console.log(`🛑 Stopping recording from: ${source}`);
    setProcessingStatus('Processing...');
    
    try {
      const audioBuffer = await audioCapture.current.stopRecording();
      setIsRecording(false); // Update state immediately
      setAudioLevel(0);
      
      await (window as any).electronAPI.stopRecording(source);
      
      if (audioBuffer.byteLength > 0) {
        const audioArray = Array.from(new Uint8Array(audioBuffer));
        const result = await (window as any).electronAPI.processAudio(audioArray, {
          model: selectedModel,
          language: selectedLanguage
        });

        setTranscription(result.text);
        setProcessingStatus(`Completed (${result.engine})`);
        setLastProcessingTime(result.processingTime);
        setDetectedLanguage(result.language || 'en');
        setCurrentModelDisplay(result.model?.split('/').pop() || selectedModel.split('/').pop() || 'base');

        if (result.text?.trim()) {
          try {
            await (window as any).electronAPI.copyToClipboard(result.text);
            setProcessingStatus('Completed - Copied to clipboard!');
            playCompletionSound(); // Soft ding on successful transcription
          } catch (e) {
            console.warn('Clipboard failed:', e);
          }
        }
      } else {
        setTranscription('');
        setProcessingStatus('No audio recorded');
      }
    } catch (error) {
      console.error('Stop recording failed:', error);
      setIsRecording(false);
      setProcessingStatus('Processing failed');
    }
  }, [isRecording]);

  const handleRecordingToggle = useCallback((source = 'unknown') => {
    console.log(`🔄 Toggle from ${source}, current state: ${isRecording}`);
    if (isRecording) {
      handleStopRecording(source);
    } else {
      handleStartRecording(source);
    }
  }, [isRecording, handleStartRecording, handleStopRecording]);

  // Cloud endpoint test connection - uses IPC to avoid CSP issues
  const handleTestConnection = useCallback(async () => {
    if (!endpointUrl) {
      alert('Please enter an endpoint URL first!');
      return;
    }

    setConnectionStatus('testing');

    try {
      // First save the config to main process
      await (window as any).electron.ipcRenderer.invoke('cloud:configure', {
        endpointUrl,
        apiKey,
        model: selectedModel,
        language: selectedLanguage
      });

      // Then test the connection via IPC (bypasses CSP)
      const result = await (window as any).electron.ipcRenderer.invoke('cloud:test-connection');

      if (result.success) {
        console.log('Cloud endpoint connected:', result);
        setConnectionStatus('connected');
        setCurrentModelDisplay(selectedModel.split('/').pop() || 'base');
        setServerDevice(result.device === 'cuda' ? 'GPU' : (result.device || 'GPU'));
        if (result.modelCount) {
          console.log(`${result.modelCount} models available`);
        }
      } else {
        alert('Connection failed: ' + (result.error || 'Unknown error'));
        setConnectionStatus('disconnected');
      }
    } catch (error: any) {
      alert('Connection failed: ' + error.message);
      setConnectionStatus('disconnected');
    }
  }, [endpointUrl, apiKey, selectedModel, selectedLanguage]);

  // Fetch system info on mount
  useEffect(() => {
    const fetchSystemInfo = async () => {
      try {
        const info = await (window as any).electronAPI.getSystemInfo();
        setSystemInfo(info);
        console.log('System info:', info);
      } catch (error) {
        console.error('Failed to get system info:', error);
      }
    };

    fetchSystemInfo();
  }, []);

  // Load saved cloud config on mount
  useEffect(() => {
    const loadCloudConfig = async () => {
      if (!isElectron) {
        setConfigLoaded(true);
        return;
      }

      try {
        const config = await (window as any).electron.ipcRenderer.invoke('cloud:get-config');
        console.log('Loaded cloud config:', config);

        if (config) {
          if (config.endpointUrl) setEndpointUrl(config.endpointUrl);
          if (config.selectedModel) setSelectedModel(config.selectedModel);
          if (config.language) setSelectedLanguage(config.language);
          if (config.isConfigured) {
            setConnectionStatus('connected');
          }
          // Always update display from loaded config
          setCurrentModelDisplay(config.selectedModel?.split('/').pop() || 'base');
        }
      } catch (error) {
        console.error('Failed to load cloud config:', error);
      } finally {
        // Mark config as loaded so save effect can start working
        setConfigLoaded(true);
      }
    };

    loadCloudConfig();
  }, [isElectron]);

  // Save cloud config when settings change - immediate save, no debounce
  // Only save AFTER config has been loaded to avoid overwriting with defaults
  useEffect(() => {
    if (!isElectron || !configLoaded) return;

    console.log('Saving cloud config, model:', selectedModel);

    // Save immediately to ensure model selection is persisted before any transcription
    (window as any).electron.ipcRenderer.invoke('cloud:configure', {
      endpointUrl,
      apiKey,
      model: selectedModel,
      language: selectedLanguage
    }).catch((err: any) => console.warn('Failed to save cloud config:', err));
  }, [isElectron, configLoaded, endpointUrl, apiKey, selectedModel, selectedLanguage]);

  // Audio level is now handled by the real-time AudioCapture callback

  // Global shortcut event listener - register only once on mount
  useEffect(() => {
    if (isElectron) {
      console.log('🔧 Setting up global shortcut listener (mount only)');
      
      // Listen for global shortcut toggle event from main process
      const unsubscribe = (window as any).electronAPI.onGlobalShortcutToggle(() => {
        console.log('🌐 Global shortcut toggle event received');
        
        // Check privacy mode first using ref for current value
        if (privacyModeRef.current) {
          console.log('🔒 Privacy mode active - showing reminder');
          setPrivacyReminder(true);
          
          // Bring window to foreground for visibility
          (window as any).electronAPI.bringToForeground().catch(err => 
            console.warn('Failed to bring window to foreground:', err)
          );
          
          // Clear reminder after animation
          setTimeout(() => setPrivacyReminder(false), 2000);
          return;
        }
        
        // Always bring window to foreground when global shortcut is used
        (window as any).electronAPI.bringToForeground().catch(err => 
          console.warn('Failed to bring window to foreground:', err)
        );
        
        // Use ref for synchronous state check to prevent race conditions
        const currentlyRecording = isRecordingRef.current;
        console.log(`🔄 Global shortcut toggle, current state: ${currentlyRecording}`);
        
        // Prevent duplicate execution by checking ref state
        if (currentlyRecording) {
          // Stop recording
          console.log('🛑 Stopping recording from: global-shortcut');
          isRecordingRef.current = false;
          setIsRecording(false);
          setProcessingStatus('Processing...');
          setAudioLevel(0);
          
          audioCapture.current.stopRecording().then(audioBuffer => {
            (window as any).electronAPI.stopRecording('global-shortcut');
            
            if (audioBuffer.byteLength > 0) {
              const audioArray = Array.from(new Uint8Array(audioBuffer));
              // Use refs to get current model/language values (not stale closure values)
              (window as any).electronAPI.processAudio(audioArray, {
                model: selectedModelRef.current,
                language: selectedLanguageRef.current
              }).then(result => {
                setTranscription(result.text);
                setProcessingStatus(`Completed (${result.engine})`);
                setLastProcessingTime(result.processingTime);
                setDetectedLanguage(result.language || 'en');
                setCurrentModelDisplay(result.model?.split('/').pop() || selectedModelRef.current.split('/').pop() || 'base');

                if (result.text?.trim()) {
                  (window as any).electronAPI.copyToClipboard(result.text).then(() => {
                    setProcessingStatus('Completed - Copied to clipboard!');
                    playCompletionSound(); // Soft ding on successful transcription
                  }).catch(e => console.warn('Clipboard failed:', e));
                }
              });
            } else {
              setTranscription('');
              setProcessingStatus('No audio recorded');
            }
          }).catch(error => {
            console.error('Stop recording failed:', error);
            setProcessingStatus('Processing failed');
          });
        } else {
          // Start recording
          console.log('🎤 Starting recording from: global-shortcut');
          isRecordingRef.current = true;
          setIsRecording(true);
          setTranscription('');
          setProcessingStatus('Starting...');
          
          audioCapture.current.startRecording(setAudioLevel).then(() => {
            setProcessingStatus('Recording...');
            (window as any).electronAPI.startRecording('global-shortcut');
          }).catch(error => {
            console.error('Start recording failed:', error);
            isRecordingRef.current = false;
            setIsRecording(false);
            setProcessingStatus('Failed to start');
          });
        }
      });
      
      // Cleanup function to remove listener
      return () => {
        console.log('🔧 Cleaning up global shortcut listener (unmount only)');
        if (typeof unsubscribe === 'function') {
          unsubscribe();
        }
      };
    }
  }, [isElectron]); // Only depend on isElectron, not changing functions


  // Note: Local keyboard shortcuts removed - using global shortcuts from main process instead
  // This prevents conflicts between global and local handlers



  return (
    <div className={`min-h-screen bg-background text-foreground transition-all duration-500 ${
      privacyReminder ? 'ring-4 ring-orange-400/50 shadow-2xl shadow-orange-400/20' : ''
    }`}>
      {/* Modern Windows 11 Title Bar with native controls */}
      <div className="title-bar draggable">
        <div className="title-bar-content">
          <div className="flex items-center gap-3 non-draggable">
            <div className="w-6 h-6 rounded-md bg-primary flex items-center justify-center">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-primary-foreground">
                <path d="M12 1L3 7V10C3 16 9 21 12 22C15 21 21 16 21 10V7L12 1Z" stroke="currentColor" strokeWidth="2" fill="currentColor" strokeLinejoin="round"/>
                <path d="M12 8V16" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
                <path d="M8 12L16 12" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
            <h1 className="text-sm font-semibold text-foreground">MVP-Echo</h1>
          </div>
        </div>
      </div>


      {/* Browser Warning */}
      {!isElectron && (
        <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 mx-6 mt-4">
          <div className="flex">
            <div className="flex-shrink-0">
              <svg className="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="ml-3">
              <p className="text-sm text-yellow-700">
                <strong>You're viewing MVP-Echo in a web browser.</strong> For full functionality including voice recording and transcription, please use the Electron desktop application that should have opened automatically.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Main Content with flex layout */}
      <div className="flex-1 flex flex-col">
        <main className="flex-1 container max-w-4xl mx-auto p-4 flex flex-col space-y-4">
        {/* Ocean Audio Visualizer with Microphone Control - Larger */}
        <div className="relative flex-1 min-h-[250px]">
          <OceanVisualizer isRecording={isRecording} audioLevel={audioLevel} />
          
          {/* Microphone Button - Bottom Right of Visualizer */}
          <div className="absolute bottom-4 right-4">
            <button
              onClick={() => handleRecordingToggle('button-click')}
              disabled={privacyMode}
              className={`w-8 h-8 rounded-full flex items-center justify-center transition-all duration-200 ${
                privacyMode
                  ? 'opacity-30 cursor-not-allowed bg-gray-400/50'
                  : `opacity-60 hover:opacity-100 ${
                      isRecording 
                        ? 'bg-red-500/80 hover:bg-red-500 text-white shadow-md shadow-red-500/20' 
                        : 'bg-primary/80 hover:bg-primary text-primary-foreground shadow-md shadow-primary/20'
                    }`
              }`}
            >
              {isRecording ? (
                <div className="w-3 h-3 bg-current rounded-sm"></div>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C10.9 2 10 2.9 10 4V12C10 13.1 10.9 14 12 14C13.1 14 14 13.1 14 12V4C14 2.9 13.1 2 12 2Z"/>
                  <path d="M18 12C18 15.3 15.3 18 12 18C8.7 18 6 15.3 6 12H4C4 16.4 7.6 20 12 20C16.4 20 20 16.4 20 12H18Z"/>
                  <path d="M11 21V23H13V21H11Z"/>
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* Content Area */}
        <div className="h-[180px] p-4 bg-muted/50 rounded-lg border-2 border-dashed border-border overflow-y-auto">
              {privacyMode ? (
                <div className="flex flex-col items-center justify-center h-full text-center space-y-3">
                  <div className={`text-6xl ${privacyReminder ? 'animate-pulse' : ''}`}>🔒</div>
                  <h3 className={`text-xl font-medium ${privacyReminder ? 'text-orange-500 animate-pulse' : 'text-gray-600'}`}>
                    Privacy Mode Active
                  </h3>
                  <p className="text-muted-foreground max-w-md">
                    Recording is disabled to protect your privacy. {privacyReminder ? 'You just tried to record!' : 'Click the lock button to resume recording.'}
                  </p>
                </div>
              ) : transcription ? (
                <div className="h-full w-full flex flex-col">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-semibold text-foreground">Transcription</h3>
                      {lastProcessingTime && (
                        <span className="text-[9px] px-2 py-0.5 bg-purple-100 text-purple-700 rounded-full font-medium">
                          {lastProcessingTime}ms
                        </span>
                      )}
                      {detectedLanguage && (
                        <span className="text-[9px] px-2 py-0.5 bg-purple-100 text-purple-700 rounded-full font-medium">
                          {detectedLanguage.toUpperCase()}
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => {
                        (window as any).electronAPI.copyToClipboard(transcription);
                      }}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors p-1 rounded hover:bg-muted/50"
                      title="Copy to clipboard"
                    >
                      📋 Copy
                    </button>
                  </div>
                  <div className="flex-1 relative">
                    <div className="h-full w-full overflow-y-auto">
                      <p className="text-sm leading-relaxed text-foreground m-0 p-0 w-full block">
                        {transcription}
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-full space-y-4">
                  {isRecording ? (
                    <p className="text-muted-foreground italic text-center">
                      🎤 Listening and processing your speech...
                    </p>
                  ) : isElectron ? (
                    <div className="text-center space-y-3 max-w-md">
                      <h3 className="text-lg font-semibold text-foreground">How to Use MVP-Echo</h3>
                      <div className="space-y-2">
                        <div className="flex items-center justify-center gap-2">
                          <span className="font-bold text-primary">Hold Ctrl+Alt</span>
                          <span className="text-muted-foreground">→</span>
                          <span className="font-bold text-green-600">Tap Z</span>
                          <span className="text-muted-foreground">to start recording</span>
                        </div>
                        <div className="flex items-center justify-center gap-2">
                          <span className="font-bold text-primary">Hold Ctrl+Alt</span>
                          <span className="text-muted-foreground">→</span>
                          <span className="font-bold text-red-600">Tap Z</span>
                          <span className="text-muted-foreground">to stop recording</span>
                        </div>
                        <div className="flex items-center justify-center gap-2">
                          <span className="font-bold text-primary">Press Ctrl+V</span>
                          <span className="text-muted-foreground">to paste anywhere</span>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground mt-3">
                        Or click the microphone button below
                      </p>
                    </div>
                  ) : (
                    <p className="text-muted-foreground italic text-center">
                      Click microphone button to record
                    </p>
                  )}
                </div>
              )}
        </div>
        </main>
        
        {/* Compact Footer Status Bar - Two Lines */}
        <footer className="bg-muted/30 border-t border-border px-4 py-2">
          <div className="container max-w-4xl mx-auto space-y-1">
            {/* Line 1: Model name in purple */}
            <div className="flex items-center justify-center">
              <span className="text-[10px] px-3 py-0.5 bg-purple-100 text-purple-700 rounded-full font-medium">
                {currentModelDisplay}
              </span>
            </div>

            {/* Line 2: Status and controls */}
            <div className="flex items-center justify-between text-[10px]">
              {/* Left: Version and Cloud */}
              <div className="flex items-center gap-2 text-muted-foreground">
                <span>v1.3.0 Light</span>
                <span>•</span>
                <span>☁️ Cloud</span>
              </div>

              {/* Right: Status and Controls */}
              <div className="flex items-center gap-3">
                {/* Status Indicator */}
                <div className="flex items-center gap-1.5">
                  {privacyMode ? (
                    <>
                      <div className={`w-1.5 h-1.5 rounded-full ${privacyReminder ? 'bg-orange-500 animate-pulse' : 'bg-gray-500'}`}></div>
                      <span className={`font-medium ${privacyReminder ? 'text-orange-500 animate-pulse' : 'text-gray-500'}`}>
                        🔒 Privacy
                      </span>
                    </>
                  ) : isRecording ? (
                    <>
                      <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"></div>
                      <span className="text-red-500 font-medium">Recording</span>
                    </>
                  ) : processingStatus === 'Processing...' ? (
                    <>
                      <div className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse"></div>
                      <span className="text-yellow-600 font-medium">Processing</span>
                    </>
                  ) : (
                    <>
                      <div className="w-1.5 h-1.5 rounded-full bg-green-500"></div>
                      <span className="text-green-600 font-medium">Ready</span>
                    </>
                  )}
                </div>

                {/* Settings Toggle Button */}
                <button
                  onClick={() => setShowSettings(!showSettings)}
                  className={`px-2 py-0.5 rounded text-[9px] font-medium transition-all duration-200 cursor-pointer border ${
                    showSettings
                      ? 'bg-slate-200 text-slate-900'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 border-transparent hover:border-slate-300'
                  }`}
                >
                  ⚙️ Settings
                </button>

                {/* Privacy Mode Toggle Button */}
                <button
                  onClick={() => {
                    console.log('Privacy button clicked, current state:', privacyMode);
                    setPrivacyMode(!privacyMode);
                    console.log('Setting privacy mode to:', !privacyMode);
                  }}
                  className={`px-2 py-0.5 rounded text-[9px] font-medium transition-all duration-200 cursor-pointer border ${
                    privacyMode
                      ? 'bg-orange-500/20 text-orange-600 hover:bg-orange-500/40 border-orange-500/30'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 border-transparent hover:border-slate-300'
                  }`}
                  title={privacyMode ? "Disable Privacy Mode" : "Enable Privacy Mode"}
                >
                  Privacy
                </button>
              </div>
            </div>

            {/* Expandable Settings Panel */}
            {showSettings && (
              <div className="border-t border-border px-4 py-3 bg-white/50">
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                    <span>☁️</span>
                    <span>Cloud Configuration</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] font-medium text-muted-foreground block mb-1">
                        Endpoint URL *
                      </label>
                      <input
                        type="text"
                        value={endpointUrl}
                        onChange={(e) => setEndpointUrl(e.target.value)}
                        placeholder="http://192.168.1.10:20300/v1/audio/transcriptions"
                        className="w-full px-2 py-1.5 text-xs bg-white border border-border rounded font-mono"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-medium text-muted-foreground block mb-1">
                        API Key (Optional)
                      </label>
                      <input
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder="sk-..."
                        className="w-full px-2 py-1.5 text-xs bg-white border border-border rounded"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] font-medium text-muted-foreground block mb-1">
                        Whisper Model
                      </label>
                      <select
                        value={selectedModel}
                        onChange={(e) => setSelectedModel(e.target.value)}
                        className="w-full px-2 py-1.5 text-xs bg-white border border-border rounded"
                      >
                        <option value="Systran/faster-whisper-tiny">tiny (fastest, 39M)</option>
                        <option value="Systran/faster-whisper-base">base (balanced, 74M)</option>
                        <option value="Systran/faster-whisper-small">small (better, 244M)</option>
                        <option value="Systran/faster-whisper-medium">medium (great, 769M)</option>
                        <option value="Systran/faster-whisper-large-v2">large-v2 (best, 1.5GB)</option>
                        <option value="Systran/faster-whisper-large-v3">large-v3 (latest, 1.5GB)</option>
                        <option value="deepdml/faster-whisper-large-v3-turbo-ct2">large-v3-turbo (fast+best)</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] font-medium text-muted-foreground block mb-1">
                        Language
                      </label>
                      <select
                        value={selectedLanguage}
                        onChange={(e) => setSelectedLanguage(e.target.value)}
                        className="w-full px-2 py-1.5 text-xs bg-white border border-border rounded"
                      >
                        <option value="">Auto-detect</option>
                        <option value="en">English (EN)</option>
                        <option value="es">Spanish (ES)</option>
                        <option value="fr">French (FR)</option>
                        <option value="de">German (DE)</option>
                        <option value="zh">Chinese (ZH)</option>
                        <option value="ja">Japanese (JA)</option>
                      </select>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {connectionStatus === 'testing' && (
                        <>
                          <div className="w-1.5 h-1.5 bg-yellow-500 rounded-full animate-pulse"></div>
                          <span className="text-xs text-yellow-600 font-medium">Testing...</span>
                        </>
                      )}
                      {connectionStatus === 'connected' && (
                        <>
                          <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></div>
                          <span className="text-xs text-green-600 font-medium">Connected ✓</span>
                        </>
                      )}
                      {connectionStatus === 'disconnected' && (
                        <>
                          <div className="w-1.5 h-1.5 bg-gray-400 rounded-full"></div>
                          <span className="text-xs text-gray-600 font-medium">Not configured</span>
                        </>
                      )}
                    </div>
                    <button
                      onClick={handleTestConnection}
                      disabled={connectionStatus === 'testing'}
                      className="px-3 py-1 bg-primary text-primary-foreground text-xs font-semibold rounded hover:bg-primary/90 disabled:opacity-50"
                    >
                      Test Connection
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </footer>
      </div>
      
      {/* Setup Progress - Shows at bottom during initialization */}
      {showSetup && (
        <SetupProgress 
          onComplete={() => {
            setIsInitialized(true);
            setShowSetup(false);
          }}
        />
      )}
      
      {/* Light version doesn't need Engine Selector (cloud only) */}
    </div>
  );
}