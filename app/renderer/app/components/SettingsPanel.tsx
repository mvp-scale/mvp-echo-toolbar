import React, { useState } from 'react';

type ModelState = 'loaded' | 'available' | 'download' | 'switching';

interface ModelOption {
  id: string;
  label: string;
  detail: string;
  group: 'gpu' | 'local';
  state: ModelState;
}

// Mock data — will be replaced with IPC calls via RemoteAdapter / LocalSidecarAdapter
const MOCK_MODELS: ModelOption[] = [
  { id: 'gpu-english', label: 'English', detail: 'Recommended', group: 'gpu', state: 'loaded' },
  { id: 'gpu-english-hd', label: 'English HD', detail: 'Highest accuracy', group: 'gpu', state: 'available' },
  { id: 'gpu-multilingual', label: 'Multilingual', detail: '25 languages', group: 'gpu', state: 'available' },
  { id: 'local-fast', label: 'Fast', detail: '75MB', group: 'local', state: 'download' },
  { id: 'local-balanced', label: 'Balanced', detail: '150MB', group: 'local', state: 'download' },
  { id: 'local-accurate', label: 'Accurate', detail: '480MB', group: 'local', state: 'download' },
];

const StateIndicator: React.FC<{ state: ModelState }> = ({ state }) => {
  switch (state) {
    case 'loaded':
      return <span className="flex items-center gap-1.5 text-[10px] text-green-400 font-medium"><span className="w-1.5 h-1.5 rounded-full bg-green-400" />loaded</span>;
    case 'available':
      return <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><span className="w-1.5 h-1.5 rounded-full border border-muted-foreground" />available</span>;
    case 'download':
      return <span className="flex items-center gap-1.5 text-[10px] text-blue-400 font-medium">↓ download</span>;
    case 'switching':
      return <span className="flex items-center gap-1.5 text-[10px] text-yellow-400 font-medium animate-pulse">⏳ switching</span>;
  }
};

interface SettingsPanelProps {
  onClose: () => void;
  serverUrl?: string;
  serverConnected?: boolean;
  idleTime?: string;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  onClose,
  serverUrl = '192.168.1.10:20300',
  serverConnected = true,
  idleTime = '5m',
}) => {
  const [models, setModels] = useState<ModelOption[]>(MOCK_MODELS);
  const [selectedModelId, setSelectedModelId] = useState('gpu-english');
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const selectedModel = models.find(m => m.id === selectedModelId);
  const gpuModels = models.filter(m => m.group === 'gpu');
  const localModels = models.filter(m => m.group === 'local');

  const handleSelectModel = (model: ModelOption) => {
    if (model.state === 'download') {
      // Would trigger download confirmation → progress → ready
      return;
    }
    if (model.state === 'available') {
      // Simulate switching
      setModels(prev => prev.map(m => ({
        ...m,
        state: m.id === model.id ? 'switching' as ModelState :
               m.id === selectedModelId ? 'available' as ModelState :
               m.state
      })));
      setTimeout(() => {
        setModels(prev => prev.map(m => ({
          ...m,
          state: m.id === model.id ? 'loaded' as ModelState : m.state
        })));
        setSelectedModelId(model.id);
      }, 2000);
    }
    setDropdownOpen(false);
  };

  return (
    <div className="absolute bottom-full right-0 mb-2 w-[340px] bg-background border border-border rounded-xl shadow-2xl overflow-visible z-50">
      {/* Header */}
      <div className="px-4 pt-3 pb-2 border-b border-border flex items-center justify-between">
        <h2 className="text-xs font-semibold text-foreground">Settings</h2>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded hover:bg-muted/50"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="px-4 py-3 space-y-4">
        {/* Server Connection */}
        <div>
          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Server
          </label>
          <div className="mt-1 flex items-center justify-between bg-muted/30 rounded-lg px-3 py-1.5 border border-border/50">
            <div className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full ${serverConnected ? 'bg-green-400' : 'bg-red-400'}`} />
              <span className="text-[11px] text-foreground">{serverUrl}</span>
            </div>
            <span className="text-[10px] text-muted-foreground">
              {serverConnected ? `idle ${idleTime}` : 'offline'}
            </span>
          </div>
        </div>

        {/* Engine & Model Dropdown */}
        <div>
          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Engine & Model
          </label>
          <div className="mt-1 relative">
            {/* Trigger */}
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="w-full flex items-center justify-between bg-muted/30 rounded-lg px-3 py-2 border border-border/50 hover:border-primary/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="text-xs">{selectedModel?.group === 'gpu' ? '⚡' : '💻'}</span>
                <span className="text-xs text-foreground font-medium">{selectedModel?.label}</span>
                {selectedModel?.detail && (
                  <span className="text-[10px] text-muted-foreground">— {selectedModel.detail}</span>
                )}
              </div>
              <svg className={`w-3 h-3 text-muted-foreground transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {/* Dropdown */}
            {dropdownOpen && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-background border border-border rounded-lg shadow-xl z-10 overflow-hidden">
                {/* GPU Server Section */}
                <div className="px-3 pt-2 pb-0.5">
                  <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">
                    GPU Server — Industry's Best
                  </span>
                </div>
                {gpuModels.map(model => (
                  <button
                    key={model.id}
                    onClick={() => handleSelectModel(model)}
                    className={`w-full flex items-center justify-between px-3 py-1.5 hover:bg-muted/50 transition-colors ${
                      model.id === selectedModelId ? 'bg-primary/5' : ''
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[11px]">⚡</span>
                      <span className="text-xs text-foreground">{model.label}</span>
                      {model.detail === 'Recommended' && (
                        <span className="text-[8px] bg-primary/10 text-primary px-1 py-0.5 rounded font-medium">
                          recommended
                        </span>
                      )}
                    </div>
                    <StateIndicator state={model.state} />
                  </button>
                ))}

                {/* Divider */}
                <div className="mx-3 my-0.5 border-t border-border" />

                {/* Local CPU Section */}
                <div className="px-3 pt-1 pb-0.5">
                  <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">
                    Local CPU — No Internet Required
                  </span>
                </div>
                {localModels.map(model => (
                  <button
                    key={model.id}
                    onClick={() => handleSelectModel(model)}
                    className={`w-full flex items-center justify-between px-3 py-1.5 hover:bg-muted/50 transition-colors ${
                      model.id === selectedModelId ? 'bg-primary/5' : ''
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[11px]">💻</span>
                      <span className="text-xs text-foreground">{model.label}</span>
                      <span className="text-[10px] text-muted-foreground">({model.detail})</span>
                    </div>
                    <StateIndicator state={model.state} />
                  </button>
                ))}
                <div className="h-0.5" />
              </div>
            )}
          </div>
        </div>

        {/* Keyboard Shortcut — just a note */}
        <div className="flex items-center justify-between bg-muted/20 rounded-lg px-3 py-1.5">
          <span className="text-[10px] text-muted-foreground">Shortcut</span>
          <span className="text-[11px] text-foreground font-mono">Ctrl+Alt+Z</span>
        </div>
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-border">
        <div className="flex items-center justify-between text-[9px] text-muted-foreground">
          <span>v3.0.0</span>
          <span>MVP-Echo Toolbar</span>
        </div>
      </div>
    </div>
  );
};
