import { useState, useEffect, useCallback, useRef } from 'react';

type ModelState = 'loaded' | 'available' | 'download' | 'switching';

interface ModelOption {
  id: string;
  label: string;
  detail: string;
  group: 'gpu' | 'local';
  state: ModelState;
}

// Client-side label fallback for when server doesn't return label/detail
const GPU_MODEL_MAP: Record<string, { label: string; detail: string }> = {
  'parakeet-tdt-0.6b-v2-int8': { label: 'English', detail: 'Recommended' },
  'parakeet-tdt-1.1b-v2-int8': { label: 'English HD', detail: 'Highest accuracy' },
  'parakeet-tdt-0.6b-v3-int8': { label: 'Multilingual', detail: '25 languages' },
};

const DEFAULT_MODELS: ModelOption[] = [
  { id: 'gpu-english', label: 'English', detail: 'Recommended', group: 'gpu', state: 'available' },
  { id: 'gpu-english-hd', label: 'English HD', detail: 'Highest accuracy', group: 'gpu', state: 'available' },
  { id: 'gpu-multilingual', label: 'Multilingual', detail: '25 languages', group: 'gpu', state: 'available' },
  { id: 'local-fast', label: 'Fast', detail: '75MB', group: 'local', state: 'download' },
  { id: 'local-balanced', label: 'Balanced', detail: '150MB', group: 'local', state: 'download' },
  { id: 'local-accurate', label: 'Accurate', detail: '480MB', group: 'local', state: 'download' },
];

const LOCAL_MODELS: ModelOption[] = [
  { id: 'local-fast', label: 'Fast', detail: '75MB', group: 'local', state: 'download' },
  { id: 'local-balanced', label: 'Balanced', detail: '150MB', group: 'local', state: 'download' },
  { id: 'local-accurate', label: 'Accurate', detail: '480MB', group: 'local', state: 'download' },
];

function StateIndicator({ state }: { state: ModelState }) {
  switch (state) {
    case 'loaded':
      return <span className="flex items-center gap-1 text-[9px] text-green-400 font-medium"><span className="w-1.5 h-1.5 rounded-full bg-green-400" />loaded</span>;
    case 'available':
      return <span className="flex items-center gap-1 text-[9px] text-muted-foreground"><span className="w-1.5 h-1.5 rounded-full border border-muted-foreground" />available</span>;
    case 'download':
      return <span className="flex items-center gap-1 text-[9px] text-blue-400 font-medium">&darr; download</span>;
    case 'switching':
      return <span className="flex items-center gap-1 text-[9px] text-yellow-400 font-medium animate-pulse">&#9203; switching</span>;
  }
}

export default function SettingsPanel() {
  const [endpointUrl, setEndpointUrl] = useState('http://192.168.1.10:20300/v1/audio/transcriptions');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<ModelOption[]>(DEFAULT_MODELS);
  const [selectedModelId, setSelectedModelId] = useState('gpu-english');
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'testing' | 'connected'>('disconnected');
  const [configLoaded, setConfigLoaded] = useState(false);
  const ipcRef = useRef<any>(null);

  const gpuModels = models.filter(m => m.group === 'gpu');
  const localModels = models.filter(m => m.group === 'local');

  // Fetch real model list from engine manager via IPC
  const fetchModels = useCallback(async () => {
    const ipc = ipcRef.current;
    if (!ipc) return;

    try {
      const serverModels: Array<{ id: string; label: string; group: string; state: string }> =
        await ipc.invoke('engine:list-models');

      if (!serverModels || serverModels.length === 0) return;

      // Map server GPU models, applying client-side fallback labels
      const gpuFromServer: ModelOption[] = serverModels
        .filter(m => m.group === 'gpu')
        .map(m => {
          const fallback = GPU_MODEL_MAP[m.id];
          return {
            id: m.id,
            label: fallback?.label || m.label || m.id,
            detail: fallback?.detail || '',
            group: 'gpu' as const,
            state: m.state as ModelState,
          };
        });

      // Merge with static local CPU models
      const merged = [...gpuFromServer, ...LOCAL_MODELS];
      setModels(merged);

      // Auto-select the loaded model
      const loaded = gpuFromServer.find(m => m.state === 'loaded');
      if (loaded) {
        setSelectedModelId(loaded.id);
      }
    } catch (e) {
      console.error('Failed to fetch models:', e);
      // Keep current models as fallback
    }
  }, []);

  // Load config on mount
  useEffect(() => {
    const ipc = (window as any).electron?.ipcRenderer;
    ipcRef.current = ipc;
    if (!ipc) { setConfigLoaded(true); return; }

    const loadConfig = async () => {
      try {
        const config = await ipc.invoke('cloud:get-config');
        if (config) {
          if (config.endpointUrl) setEndpointUrl(config.endpointUrl);
          if (config.apiKey) setApiKey(config.apiKey);
          if (config.selectedModel) setSelectedModelId(config.selectedModel);
          if (config.isConfigured) {
            setConnectionStatus('connected');
          }
        }
      } catch (e) {
        console.error('Failed to load cloud config:', e);
      } finally {
        setConfigLoaded(true);
      }
    };
    loadConfig().then(() => fetchModels());
  }, [fetchModels]);

  // Save config when endpoint/apiKey change (not selectedModelId -- saved explicitly on switch)
  useEffect(() => {
    if (!configLoaded) return;
    const ipc = ipcRef.current;
    if (!ipc) return;

    ipc.invoke('cloud:configure', {
      endpointUrl,
      apiKey,
    }).catch((err: Error) => console.warn('Failed to save cloud config:', err));
  }, [configLoaded, endpointUrl, apiKey]);

  const handleDebug = useCallback(() => {
    (window as any).electron?.ipcRenderer?.invoke('debug:open-devtools').catch(() => {});
  }, []);

  const handleTestConnection = useCallback(async () => {
    if (!endpointUrl) return;
    setConnectionStatus('testing');

    try {
      const ipc = ipcRef.current;
      if (!ipc) { setConnectionStatus('disconnected'); return; }

      await ipc.invoke('cloud:configure', {
        endpointUrl,
        apiKey,
      });

      const result = await ipc.invoke('cloud:test-connection');
      setConnectionStatus(result.success ? 'connected' : 'disconnected');

      if (result.success) {
        await fetchModels();
      }
    } catch (_error) {
      setConnectionStatus('disconnected');
    }
  }, [endpointUrl, apiKey, fetchModels]);

  const handleSelectModel = useCallback(async (model: ModelOption) => {
    if (model.state === 'download' || model.state === 'switching') {
      return;
    }

    if (model.state === 'loaded') {
      setSelectedModelId(model.id);
      return;
    }

    // state === 'available': optimistic UI then real IPC switch
    const previousSelectedId = selectedModelId;

    setModels(prev => prev.map(m => ({
      ...m,
      state: m.id === model.id ? 'switching' as ModelState :
             m.id === previousSelectedId ? 'available' as ModelState :
             m.state
    })));

    const ipc = ipcRef.current;
    if (!ipc) return;

    try {
      const result = await ipc.invoke('engine:switch-model', model.id);
      if (result.success) {
        setModels(prev => prev.map(m => ({
          ...m,
          state: m.id === model.id ? 'loaded' as ModelState :
                 m.group === 'gpu' && m.state === 'loaded' ? 'available' as ModelState :
                 m.state
        })));
        setSelectedModelId(model.id);

        // Persist the new model selection
        ipc.invoke('cloud:configure', { model: model.id }).catch(() => {});
      } else {
        // Switch failed -- re-fetch real state
        console.error('Model switch failed:', result.error);
        await fetchModels();
      }
    } catch (e) {
      console.error('Model switch error:', e);
      await fetchModels();
    }
  }, [selectedModelId, fetchModels]);

  return (
    <div className="border-t border-border px-3 py-2 bg-muted/20 max-h-[400px] overflow-y-auto">
      <div className="space-y-2">
        {/* Endpoint URL */}
        <div>
          <label className="text-[9px] font-medium text-muted-foreground block mb-0.5">
            Endpoint URL
          </label>
          <input
            type="text"
            value={endpointUrl}
            onChange={(e) => setEndpointUrl(e.target.value)}
            placeholder="http://192.168.1.10:20300/v1/audio/transcriptions"
            className="w-full px-2 py-1 text-[10px] bg-background border border-border rounded font-mono"
          />
        </div>

        {/* API Key */}
        <div>
          <label className="text-[9px] font-medium text-muted-foreground block mb-0.5">
            API Key
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            className="w-full px-2 py-1 text-[10px] bg-background border border-border rounded"
          />
        </div>

        {/* Engine & Model */}
        <div>
          <label className="text-[9px] font-medium text-muted-foreground block mb-0.5">
            Engine & Model
          </label>

          {/* GPU Server */}
          <div className="text-[8px] font-semibold text-muted-foreground uppercase tracking-wider mt-1 mb-0.5 px-1">
            GPU Server — Industry's Best, Fastest
          </div>
          {gpuModels.map(model => (
            <button
              key={model.id}
              onClick={() => handleSelectModel(model)}
              className={`w-full flex items-center justify-between px-2 py-1 rounded transition-colors text-left ${
                model.id === selectedModelId ? 'bg-primary/10' : 'hover:bg-muted/50'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span className="text-[10px]">&#9889;</span>
                <span className="text-[10px] text-foreground">{model.label}</span>
                {model.detail === 'Recommended' && (
                  <span className="text-[7px] bg-primary/10 text-primary px-1 py-0.5 rounded font-medium">
                    recommended
                  </span>
                )}
              </div>
              <StateIndicator state={model.state} />
            </button>
          ))}

          {/* Divider */}
          <div className="my-1 border-t border-border" />

          {/* Local CPU */}
          <div className="text-[8px] font-semibold text-muted-foreground uppercase tracking-wider mb-0.5 px-1">
            Local CPU — Industry's Best, No Internet Required
          </div>
          {localModels.map(model => (
            <button
              key={model.id}
              onClick={() => handleSelectModel(model)}
              className={`w-full flex items-center justify-between px-2 py-1 rounded transition-colors text-left ${
                model.id === selectedModelId ? 'bg-primary/10' : 'hover:bg-muted/50'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span className="text-[10px]">&#128187;</span>
                <span className="text-[10px] text-foreground">{model.label}</span>
                <span className="text-[9px] text-muted-foreground">({model.detail})</span>
              </div>
              <StateIndicator state={model.state} />
            </button>
          ))}
        </div>

        {/* Connection Status + Actions */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {connectionStatus === 'testing' && (
              <>
                <div className="w-1.5 h-1.5 bg-yellow-500 rounded-full animate-pulse"></div>
                <span className="text-[9px] text-yellow-600 font-medium">Testing...</span>
              </>
            )}
            {connectionStatus === 'connected' && (
              <>
                <div className="w-1.5 h-1.5 bg-green-500 rounded-full"></div>
                <span className="text-[9px] text-green-600 font-medium">Connected</span>
              </>
            )}
            {connectionStatus === 'disconnected' && (
              <>
                <div className="w-1.5 h-1.5 bg-gray-400 rounded-full"></div>
                <span className="text-[9px] text-gray-500 font-medium">Not configured</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleDebug}
              className="px-2 py-0.5 text-[9px] font-medium rounded transition-all cursor-pointer border text-muted-foreground hover:text-foreground hover:bg-muted border-transparent"
            >
              Debug
            </button>
            <button
              onClick={handleTestConnection}
              disabled={connectionStatus === 'testing'}
              className="px-2 py-0.5 bg-primary text-primary-foreground text-[9px] font-semibold rounded hover:bg-primary/90 disabled:opacity-50"
            >
              Test Connection
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
