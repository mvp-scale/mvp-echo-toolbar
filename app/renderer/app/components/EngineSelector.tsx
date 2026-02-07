import React, { useState, useEffect } from 'react';

interface EngineInfo {
  name: string;
  description: string;
  speed: string;
  accuracy: string;
  setupTime: string;
  requirements: string;
  icon: string;
  active?: boolean;
  available?: boolean;
}

interface PerformanceData {
  native: EngineInfo;
  python: EngineInfo;
}

export const EngineSelector: React.FC = () => {
  const [currentEngine, setCurrentEngine] = useState<'native' | 'python'>('native');
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [isUpgrading, setIsUpgrading] = useState(false);
  const [upgradeProgress, setUpgradeProgress] = useState(0);
  const [gpuAvailable, setGpuAvailable] = useState(false);
  const [engines, setEngines] = useState<PerformanceData>({
    native: {
      name: 'Whisper Native',
      description: 'Works immediately, no setup',
      speed: '1x',
      accuracy: 'Good',
      setupTime: '0 seconds',
      requirements: 'None',
      icon: '🚀',
      active: true,
      available: true
    },
    python: {
      name: 'Faster-Whisper',
      description: 'Professional grade accuracy',
      speed: '4-5x',
      accuracy: 'Excellent',
      setupTime: '2-3 minutes',
      requirements: 'Python + 500MB',
      icon: '🐍',
      active: false,
      available: false
    }
  });

  useEffect(() => {
    checkEngineStatus();
  }, []);

  const checkEngineStatus = async () => {
    const status = await window.electron.ipcRenderer.invoke('engine:status');
    setCurrentEngine(status.current);
    setGpuAvailable(status.gpu);
    
    // Update engine info with GPU multipliers
    if (status.gpu) {
      setEngines(prev => ({
        native: {
          ...prev.native,
          speed: '5-10x with GPU'
        },
        python: {
          ...prev.python,
          speed: '15-30x with GPU',
          available: status.pythonAvailable
        }
      }));
    }
  };

  const handleUpgrade = async () => {
    setIsUpgrading(true);
    setUpgradeProgress(0);
    
    // Listen for progress updates
    window.electron.ipcRenderer.on('engine:upgrade-progress', (_event, progress) => {
      setUpgradeProgress(progress.percent);
    });
    
    const result = await window.electron.ipcRenderer.invoke('engine:upgrade', 'python');
    
    if (result.success) {
      setCurrentEngine('python');
      setEngines(prev => ({
        ...prev,
        python: { ...prev.python, active: true }
      }));
    }
    
    setIsUpgrading(false);
    setShowUpgrade(false);
  };

  const PerformanceChart = () => (
    <div className="grid grid-cols-2 gap-4 mb-6">
      <div className="space-y-3">
        <h4 className="font-semibold text-sm text-gray-700">Processing Speed</h4>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-600">Native (CPU)</span>
            <div className="flex items-center gap-2">
              <div className="w-20 h-2 bg-blue-200 rounded-full">
                <div className="w-4 h-2 bg-blue-500 rounded-full" />
              </div>
              <span className="text-xs font-medium">1x</span>
            </div>
          </div>
          
          {gpuAvailable && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-600">Native (GPU)</span>
              <div className="flex items-center gap-2">
                <div className="w-20 h-2 bg-green-200 rounded-full">
                  <div className="w-10 h-2 bg-green-500 rounded-full" />
                </div>
                <span className="text-xs font-medium">5-10x</span>
              </div>
            </div>
          )}
          
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-600">Python (CPU)</span>
            <div className="flex items-center gap-2">
              <div className="w-20 h-2 bg-purple-200 rounded-full">
                <div className="w-8 h-2 bg-purple-500 rounded-full" />
              </div>
              <span className="text-xs font-medium">4-5x</span>
            </div>
          </div>
          
          {gpuAvailable && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-600">Python (GPU)</span>
              <div className="flex items-center gap-2">
                <div className="w-20 h-2 bg-orange-200 rounded-full">
                  <div className="w-16 h-2 bg-orange-500 rounded-full" />
                </div>
                <span className="text-xs font-medium">15-30x</span>
              </div>
            </div>
          )}
        </div>
      </div>
      
      <div className="space-y-3">
        <h4 className="font-semibold text-sm text-gray-700">Accuracy Level</h4>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-600">Native</span>
            <div className="flex items-center gap-1">
              {[1, 2, 3].map(i => (
                <div key={i} className="w-2 h-2 bg-yellow-400 rounded-full" />
              ))}
              {[4, 5].map(i => (
                <div key={i} className="w-2 h-2 bg-gray-200 rounded-full" />
              ))}
            </div>
          </div>
          
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-600">Python</span>
            <div className="flex items-center gap-1">
              {[1, 2, 3, 4, 5].map(i => (
                <div key={i} className="w-2 h-2 bg-yellow-400 rounded-full" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Current Engine Status Bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-gray-50 border-t border-gray-200 px-4 py-2">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-600">Engine:</span>
            <div className="flex items-center gap-2">
              <span className="text-2xl">{engines[currentEngine].icon}</span>
              <span className="font-medium text-sm">{engines[currentEngine].name}</span>
              {gpuAvailable && (
                <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded-full">
                  GPU Enabled
                </span>
              )}
            </div>
          </div>
          
          {currentEngine === 'native' && engines.python.available && (
            <button
              onClick={() => setShowUpgrade(true)}
              className="px-3 py-1 bg-blue-500 text-white text-sm rounded-md hover:bg-blue-600 transition-colors"
            >
              Upgrade Performance
            </button>
          )}
        </div>
      </div>

      {/* Upgrade Modal */}
      {showUpgrade && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-2xl p-6 max-w-lg w-full mx-4">
            <h2 className="text-xl font-bold mb-4">Upgrade to Faster-Whisper</h2>
            
            <PerformanceChart />
            
            <div className="bg-blue-50 rounded-lg p-4 mb-4">
              <h3 className="font-semibold text-sm mb-2">What you'll get:</h3>
              <ul className="space-y-1 text-sm text-gray-700">
                <li className="flex items-start gap-2">
                  <span className="text-green-500 mt-0.5">✓</span>
                  <span>4-5x faster processing (15-30x with GPU)</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-green-500 mt-0.5">✓</span>
                  <span>Professional-grade accuracy</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-green-500 mt-0.5">✓</span>
                  <span>Advanced features like speaker detection</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-green-500 mt-0.5">✓</span>
                  <span>Works offline after setup</span>
                </li>
              </ul>
            </div>
            
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-4">
              <p className="text-xs text-yellow-800">
                <strong>Note:</strong> This will download Python and Faster-Whisper models (~500MB). 
                Internet connection required for setup only.
              </p>
            </div>
            
            {isUpgrading ? (
              <div className="space-y-2">
                <div className="flex justify-between text-sm text-gray-600">
                  <span>Downloading and installing...</span>
                  <span>{upgradeProgress}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                    style={{ width: `${upgradeProgress}%` }}
                  />
                </div>
              </div>
            ) : (
              <div className="flex gap-3">
                <button
                  onClick={() => setShowUpgrade(false)}
                  className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
                >
                  Stay with Native
                </button>
                <button
                  onClick={handleUpgrade}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >
                  Upgrade Now
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};