import React, { useState, useEffect } from 'react';

interface SetupStep {
  id: string;
  title: string;
  description: string;
  action: () => Promise<void>;
}

interface DownloadProgress {
  type: 'model' | 'python';
  progress: number;
  downloaded: number;
  total: number;
}

export const SetupWizard: React.FC<{ onComplete: () => void }> = ({ onComplete }) => {
  const [currentStep, setCurrentStep] = useState(0);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const steps: SetupStep[] = [
    {
      id: 'welcome',
      title: 'Welcome to MVP-Echo',
      description: 'This one-time setup will download the necessary components for offline voice transcription.',
      action: async () => {
        // Just proceed to next step
      }
    },
    {
      id: 'python',
      title: 'Download Python Runtime',
      description: 'Downloading Python embedded distribution (10MB)...',
      action: async () => {
        setIsDownloading(true);
        setError(null);
        
        try {
          const result = await window.electron.ipcRenderer.invoke('setup:download-python');
          if (!result.success) {
            throw new Error(result.error);
          }
        } catch (err) {
          setError(err.message);
          throw err;
        } finally {
          setIsDownloading(false);
        }
      }
    },
    {
      id: 'model',
      title: 'Download Whisper Model',
      description: 'Downloading Whisper Tiny model (145MB) for voice recognition...',
      action: async () => {
        setIsDownloading(true);
        setError(null);
        
        try {
          const result = await window.electron.ipcRenderer.invoke('setup:download-model', 'tiny');
          if (!result.success) {
            throw new Error(result.error);
          }
        } catch (err) {
          setError(err.message);
          throw err;
        } finally {
          setIsDownloading(false);
        }
      }
    },
    {
      id: 'complete',
      title: 'Setup Complete!',
      description: 'MVP-Echo is ready to use. You can now transcribe voice completely offline.',
      action: async () => {
        await window.electron.ipcRenderer.invoke('setup:complete');
        onComplete();
      }
    }
  ];

  useEffect(() => {
    // Listen for download progress
    const handleProgress = (progress: DownloadProgress) => {
      setDownloadProgress(progress);
    };

    window.electron.ipcRenderer.on('setup:download-progress', handleProgress);
    
    return () => {
      window.electron.ipcRenderer.removeListener('setup:download-progress', handleProgress);
    };
  }, []);

  const handleNext = async () => {
    try {
      await steps[currentStep].action();
      
      if (currentStep < steps.length - 1) {
        setCurrentStep(currentStep + 1);
        setDownloadProgress(null);
      }
    } catch (err) {
      console.error('Setup step failed:', err);
    }
  };

  const formatBytes = (bytes: number) => {
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  };

  const currentStepData = steps[currentStep];

  return (
    <div className="fixed inset-0 bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center">
      <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full">
        <div className="mb-6">
          <div className="flex justify-between mb-4">
            {steps.map((step, index) => (
              <div
                key={step.id}
                className={`w-3 h-3 rounded-full ${
                  index <= currentStep ? 'bg-blue-600' : 'bg-gray-300'
                }`}
              />
            ))}
          </div>
          
          <h2 className="text-2xl font-bold text-gray-900 mb-2">
            {currentStepData.title}
          </h2>
          
          <p className="text-gray-600">
            {currentStepData.description}
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-red-700 text-sm">{error}</p>
          </div>
        )}

        {isDownloading && downloadProgress && (
          <div className="mb-6">
            <div className="flex justify-between text-sm text-gray-600 mb-2">
              <span>Downloading {downloadProgress.type}...</span>
              <span>{formatBytes(downloadProgress.downloaded)} / {formatBytes(downloadProgress.total)}</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                style={{ width: `${downloadProgress.progress}%` }}
              />
            </div>
            <p className="text-center text-sm text-gray-500 mt-2">
              {downloadProgress.progress.toFixed(1)}%
            </p>
          </div>
        )}

        <div className="flex justify-between">
          {currentStep > 0 && currentStep < steps.length - 1 && (
            <button
              onClick={() => setCurrentStep(currentStep - 1)}
              disabled={isDownloading}
              className="px-4 py-2 text-gray-600 hover:text-gray-800 disabled:opacity-50"
            >
              Back
            </button>
          )}
          
          <button
            onClick={handleNext}
            disabled={isDownloading}
            className={`px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed ${
              currentStep === 0 || currentStep === steps.length - 1 ? 'ml-auto' : ''
            }`}
          >
            {currentStep === 0 ? 'Get Started' : 
             currentStep === steps.length - 1 ? 'Launch MVP-Echo' :
             isDownloading ? 'Downloading...' : 'Continue'}
          </button>
        </div>

        {currentStep === 0 && (
          <div className="mt-6 p-4 bg-blue-50 rounded-lg">
            <h3 className="font-semibold text-blue-900 mb-2">What will be downloaded:</h3>
            <ul className="text-sm text-blue-700 space-y-1">
              <li>• Python embedded runtime (10MB)</li>
              <li>• Whisper Tiny model (145MB)</li>
              <li>• Total download: ~155MB</li>
            </ul>
            <p className="text-xs text-blue-600 mt-2">
              After setup, MVP-Echo works completely offline!
            </p>
          </div>
        )}
      </div>
    </div>
  );
};