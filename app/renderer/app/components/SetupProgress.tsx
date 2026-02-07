import React, { useEffect, useState } from 'react';

interface InitStep {
  id: number;
  message: string;
  status: 'progress' | 'success' | 'error' | 'info';
  timestamp: string;
}

interface SetupProgressProps {
  onComplete?: () => void;
}

export const SetupProgress: React.FC<SetupProgressProps> = ({ onComplete }) => {
  const [steps, setSteps] = useState<InitStep[]>([]);
  const [isInitializing, setIsInitializing] = useState(false);
  const [isComplete, setIsComplete] = useState(false);

  useEffect(() => {
    // Check initial status
    checkInitStatus();
    
    // Listen for status updates
    const handleStatus = (_event: any, data: any) => {
      setSteps(data.steps);
      
      // Check if complete
      const lastStep = data.steps[data.steps.length - 1];
      if (lastStep?.message?.includes('complete')) {
        setIsComplete(true);
        setIsInitializing(false);
        setTimeout(() => {
          onComplete?.();
        }, 2000);
      }
    };

    window.electron.ipcRenderer.on('init:status', handleStatus);
    
    return () => {
      window.electron.ipcRenderer.removeListener('init:status', handleStatus);
    };
  }, [onComplete]);

  const checkInitStatus = async () => {
    const status = await window.electron.ipcRenderer.invoke('init:check');
    
    if (!status.initialized) {
      // Start initialization automatically
      startInitialization();
    } else {
      setIsComplete(true);
      onComplete?.();
    }
  };

  const startInitialization = async () => {
    setIsInitializing(true);
    await window.electron.ipcRenderer.invoke('init:start');
  };

  if (!isInitializing && isComplete) {
    return null; // Hide when complete
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'success':
        return '✓';
      case 'error':
        return '✗';
      case 'info':
        return 'ℹ';
      case 'progress':
        return '⋯';
      default:
        return '○';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'success':
        return 'text-green-600';
      case 'error':
        return 'text-red-600';
      case 'info':
        return 'text-blue-600';
      case 'progress':
        return 'text-yellow-600';
      default:
        return 'text-gray-400';
    }
  };

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg">
      <div className="max-w-4xl mx-auto p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-700">
            System Initialization
          </h3>
          {isComplete && (
            <span className="text-sm text-green-600 font-medium">
              Ready to use!
            </span>
          )}
        </div>
        
        <div className="space-y-1">
          {steps.map((step, index) => (
            <div
              key={step.id}
              className={`flex items-center space-x-2 text-sm ${
                index === steps.length - 1 ? 'font-medium' : 'opacity-75'
              }`}
            >
              <span className={`${getStatusColor(step.status)}`}>
                {getStatusIcon(step.status)}
              </span>
              <span className="text-gray-700">{step.message}</span>
            </div>
          ))}
        </div>

        {steps.length === 0 && isInitializing && (
          <div className="flex items-center space-x-2">
            <div className="animate-spin h-4 w-4 border-2 border-blue-600 border-t-transparent rounded-full"></div>
            <span className="text-sm text-gray-600">Starting initialization...</span>
          </div>
        )}
        
        <div className="mt-3 text-xs text-gray-500">
          This one-time setup ensures MVP-Echo works completely offline after initialization.
        </div>
      </div>
    </div>
  );
};