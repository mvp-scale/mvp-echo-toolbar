import { useState, useEffect, useCallback, useRef } from 'react';

type ModelState = 'loaded' | 'available' | 'switching';

interface ModelOption {
  id: string;
  label: string;
  quality: string;
  speed: string;
  rating: number; // out of 5, supports halves (e.g. 2.5)
  group: 'gpu' | 'local';
  state: ModelState;
}

// Map server model IDs → client-side display properties
const GPU_MODEL_MAP: Record<string, { label: string; quality: string; speed: string; rating: number; isDefault: boolean }> = {
  'parakeet-tdt-0.6b-v2-int8': { label: 'English', quality: '99%', speed: '<300ms', rating: 5, isDefault: true },
  'parakeet-tdt-0.6b-v3-int8': { label: 'Multilingual', quality: '97%', speed: '<500ms', rating: 4, isDefault: false },
};

const DEFAULT_MODELS: ModelOption[] = [
  { id: 'gpu-english', label: 'English', quality: '99%', speed: '<300ms', rating: 5, group: 'gpu', state: 'loaded' },
  { id: 'gpu-multilingual', label: 'Multilingual', quality: '97%', speed: '<500ms', rating: 4, group: 'gpu', state: 'available' },
  { id: 'local-fast', label: 'English CPU', quality: '80%', speed: '<2s', rating: 2.5, group: 'local', state: 'available' },
];

const LOCAL_MODELS: ModelOption[] = [
  { id: 'local-fast', label: 'English CPU', quality: '80%', speed: '<2s', rating: 2.5, group: 'local', state: 'available' },
];

function StarRating({ rating }: { rating: number }) {
  const dots = [];
  for (let i = 1; i <= 5; i++) {
    if (i <= Math.floor(rating)) {
      // Full dot
      dots.push(<span key={i} className="w-1.5 h-1.5 rounded-full bg-blue-400" />);
    } else if (i - 0.5 === rating) {
      // Half dot
      dots.push(
        <span key={i} className="w-1.5 h-1.5 rounded-full overflow-hidden relative bg-muted-foreground/20">
          <span className="absolute inset-y-0 left-0 w-1/2 bg-blue-400" />
        </span>
      );
    } else {
      // Empty dot
      dots.push(<span key={i} className="w-1.5 h-1.5 rounded-full bg-muted-foreground/20" />);
    }
  }
  return <span className="flex items-center gap-0.5">{dots}</span>;
}

function StateIndicator({ state }: { state: ModelState }) {
  switch (state) {
    case 'loaded':
      return <span className="flex items-center gap-1 text-[9px] text-green-400 font-medium"><span className="w-1.5 h-1.5 rounded-full bg-green-400" />loaded</span>;
    case 'available':
      return <span className="flex items-center gap-1 text-[9px] text-muted-foreground"><span className="w-1.5 h-1.5 rounded-full border border-muted-foreground" />available</span>;
    case 'switching':
      return <span className="flex items-center gap-1 text-[9px] text-yellow-400 font-medium animate-pulse">&#9203; switching</span>;
  }
}

export default function SettingsPanel() {
  const [endpointUrl, setEndpointUrl] = useState('http://192.168.1.10:20300/v1/audio/transcriptions');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<ModelOption[]>(DEFAULT_MODELS);
  const [selectedModelId, setSelectedModelId] = useState('local-fast');
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'testing' | 'connected'>('disconnected');
  const [configLoaded, setConfigLoaded] = useState(false);
  const ipcRef = useRef<any>(null);

  const gpuModels = models.filter(m => m.group === 'gpu');
  const localModels = models.filter(m => m.group === 'local');
  const isLocalActive = selectedModelId.startsWith('local-');

  // Fetch real model list from engine manager via IPC
  const fetchModels = useCallback(async () => {
    const ipc = ipcRef.current;
    if (!ipc) return;

    try {
      const serverModels: Array<{ id: string; label: string; group: string; state: string }> =
        await ipc.invoke('engine:list-models');

      if (!serverModels || serverModels.length === 0) return;

      // Map server GPU models, applying client-side display properties
      const gpuFromServer: ModelOption[] = serverModels
        .filter(m => m.group === 'gpu')
        .filter(m => GPU_MODEL_MAP[m.id]) // Only show models we have display data for
        .map(m => {
          const info = GPU_MODEL_MAP[m.id];
          return {
            id: m.id,
            label: info.label,
            quality: info.quality,
            speed: info.speed,
            rating: info.rating,
            group: 'gpu' as const,
            state: m.state as ModelState,
          };
        });

      // Map local models from server, with fallback to static defaults
      const localFromServer: ModelOption[] = serverModels
        .filter(m => m.group === 'local')
        .map(m => {
          const staticMatch = LOCAL_MODELS.find(lm => lm.id === m.id);
          return staticMatch
            ? { ...staticMatch, state: m.state as ModelState }
            : { id: m.id, label: m.label || m.id, quality: '80%', speed: '<2s', rating: 2.5, group: 'local' as const, state: m.state as ModelState };
        });

      // Use server GPU models if available, otherwise keep defaults
      const gpuList = gpuFromServer.length > 0
        ? gpuFromServer
        : DEFAULT_MODELS.filter(m => m.group === 'gpu');
      const localList = localFromServer.length > 0
        ? localFromServer
        : LOCAL_MODELS;

      setModels([...gpuList, ...localList]);
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
    if (model.state === 'switching') {
      return;
    }

    // Treat both 'loaded' and 'available' the same — always make the IPC call.
    // For 'loaded', this validates connectivity; the server short-circuits if
    // the same model is already loaded.
    const previousSelectedId = selectedModelId;

    setModels(prev => prev.map(m => ({
      ...m,
      state: m.id === model.id ? 'switching' as ModelState :
             m.id === previousSelectedId ? 'available' as ModelState :
             m.state === 'loaded' ? 'available' as ModelState :
             m.state
    })));

    const ipc = ipcRef.current;

    // Resolve the switch — real IPC or simulated browser preview
    const completeSwitch = () => {
      setModels(prev => prev.map(m => ({
        ...m,
        state: m.id === model.id ? 'loaded' as ModelState :
               m.state === 'switching' ? 'available' as ModelState :
               m.state === 'loaded' ? 'available' as ModelState :
               m.state
      })));
      setSelectedModelId(model.id);
    };

    if (!ipc) {
      // Browser preview: simulate switching delay
      const delay = model.group === 'local' ? 500 : 3000;
      setTimeout(completeSwitch, delay);
      return;
    }

    try {
      const result = await ipc.invoke('engine:switch-model', model.id);
      if (result.success) {
        completeSwitch();
        ipc.invoke('cloud:configure', { model: model.id }).catch(() => {});
      } else {
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
        {/* Endpoint URL -- hidden when local CPU model is active */}
        {!isLocalActive && (
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
        )}

        {/* API Key -- hidden when local CPU model is active */}
        {!isLocalActive && (
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
        )}

        {/* Connection Status + Test -- hidden when local CPU model is active */}
        {!isLocalActive && (
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
            <button
              onClick={handleTestConnection}
              disabled={connectionStatus === 'testing'}
              className="px-2 py-0.5 bg-primary text-primary-foreground text-[9px] font-semibold rounded hover:bg-primary/90 disabled:opacity-50"
            >
              Test Connection
            </button>
          </div>
        )}

        {/* Engine & Model */}
        <div>
          <label className="text-[9px] font-medium text-muted-foreground block mb-0.5">
            Engine & Model
          </label>

          {/* GPU Server */}
          <div className="text-[8px] font-semibold text-muted-foreground uppercase tracking-wider mt-1 mb-0.5 px-1">
            Hosted GPU — Industry's Best, Fastest
          </div>
          {/* Column headers */}
          <div className="flex items-center px-2 py-0.5 text-[8px] text-muted-foreground uppercase tracking-wider">
            <span className="flex-1">Model</span>
            <span className="w-[44px] text-right">Quality</span>
            <span className="w-[44px] text-right">Speed</span>
            <span className="w-[52px] text-right">Rating</span>
          </div>

          {gpuModels.map(model => (
            <button
              key={model.id}
              onClick={() => handleSelectModel(model)}
              className={`w-full flex items-center px-2 py-1 rounded transition-colors text-left ${
                model.state === 'loaded' ? 'bg-primary/10' : 'hover:bg-muted/50'
              }`}
            >
              <div className="flex-1 flex items-center gap-1.5 min-w-0">
                {model.state === 'loaded' && <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />}
                {model.state === 'switching' && <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse shrink-0" />}
                {model.state === 'available' && <span className="w-1.5 h-1.5 rounded-full border border-muted-foreground/40 shrink-0" />}
                <span className={`text-[10px] ${model.state === 'switching' ? 'text-orange-400 font-semibold' : 'text-foreground'}`}>
                  {model.state === 'switching' ? 'Switching...' : model.label}
                </span>
                {model.id === 'gpu-english' && model.state !== 'switching' && (
                  <span className="text-[7px] bg-primary/10 text-primary px-1 py-0.5 rounded font-medium">
                    recommended
                  </span>
                )}
              </div>
              <span className="w-[44px] text-right text-[9px] text-foreground font-bold">{model.quality}</span>
              <span className="w-[44px] text-right text-[9px] text-foreground font-bold">{model.speed}</span>
              <span className="w-[52px] flex justify-end"><StarRating rating={model.rating} /></span>
            </button>
          ))}

          {/* Divider */}
          <div className="my-1 border-t border-border" />

          {/* Local CPU */}
          <div className="text-[8px] font-semibold text-muted-foreground uppercase tracking-wider mb-0.5 px-1">
            Local CPU — No Internet Required
          </div>
          {localModels.map(model => (
            <button
              key={model.id}
              onClick={() => handleSelectModel(model)}
              className={`w-full flex items-center px-2 py-1 rounded transition-colors text-left ${
                model.state === 'loaded' ? 'bg-primary/10' : 'hover:bg-muted/50'
              }`}
            >
              <div className="flex-1 flex items-center gap-1.5 min-w-0">
                {model.state === 'loaded' && <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />}
                {model.state === 'switching' && <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse shrink-0" />}
                {model.state === 'available' && <span className="w-1.5 h-1.5 rounded-full border border-muted-foreground/40 shrink-0" />}
                <span className={`text-[10px] ${model.state === 'switching' ? 'text-orange-400 font-semibold' : 'text-foreground'}`}>
                  {model.state === 'switching' ? 'Switching...' : model.label}
                </span>
              </div>
              <span className="w-[44px] text-right text-[9px] text-foreground font-bold">{model.quality}</span>
              <span className="w-[44px] text-right text-[9px] text-foreground font-bold">{model.speed}</span>
              <span className="w-[52px] flex justify-end"><StarRating rating={model.rating} /></span>
            </button>
          ))}
        </div>

      </div>
    </div>
  );
}
