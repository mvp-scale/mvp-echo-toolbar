import { useState, useEffect, useCallback, useRef } from 'react';

type ModelState = 'loaded' | 'available' | 'switching' | 'downloading' | 'download';

interface ModelOption {
  id: string;
  label: string;
  quality: string;
  speed: string;
  rating: number; // out of 5, supports halves (e.g. 2.5)
  group: 'gpu' | 'local' | 'webgpu';
  state: ModelState;
  note?: string;
}

// Map server model IDs → client-side display properties
const GPU_MODEL_MAP: Record<string, { label: string; quality: string; speed: string; rating: number; isDefault: boolean }> = {
  'parakeet-tdt-0.6b-v2-int8': { label: 'English', quality: '99%', speed: '<300ms', rating: 5, isDefault: true },
  'parakeet-tdt-0.6b-v3-int8': { label: 'Multilingual', quality: '97%', speed: '<500ms', rating: 4, isDefault: false },
};

const WEBGPU_MODEL_META: Record<string, { label: string; quality: string; speed: string; rating: number }> = {
  'webgpu-parakeet-0.6b': { label: 'English GPU', quality: '98%', speed: '<400ms', rating: 4.5 },
};

const DEFAULT_MODELS: ModelOption[] = [
  { id: 'gpu-english', label: 'English', quality: '99%', speed: '<300ms', rating: 5, group: 'gpu', state: 'available' },
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
      dots.push(<span key={i} className="w-1.5 h-1.5 rounded-full bg-blue-400" />);
    } else if (i - 0.5 === rating) {
      dots.push(
        <span key={i} className="w-1.5 h-1.5 rounded-full overflow-hidden relative bg-muted-foreground/20">
          <span className="absolute inset-y-0 left-0 w-1/2 bg-blue-400" />
        </span>
      );
    } else {
      dots.push(<span key={i} className="w-1.5 h-1.5 rounded-full bg-muted-foreground/20" />);
    }
  }
  return <span className="flex items-center gap-0.5">{dots}</span>;
}

function ModelCard({ model, onSelect }: { model: ModelOption; onSelect: (m: ModelOption) => void }) {
  const isActive = model.state === 'loaded';
  const isSwitching = model.state === 'switching';
  const isDownloading = model.state === 'downloading';
  const needsDownload = model.state === 'download';
  const isBusy = isSwitching || isDownloading;

  return (
    <button
      onClick={() => onSelect(model)}
      disabled={isBusy}
      className={`w-full flex items-center px-2 py-1 rounded transition-colors text-left ${
        isActive ? 'bg-primary/10' : isBusy ? '' : 'hover:bg-muted/50'
      } ${isBusy ? 'cursor-wait' : ''}`}
    >
      <div className="flex-1 flex items-center gap-1.5 min-w-0">
        {isActive && <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />}
        {isSwitching && <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse shrink-0" />}
        {isDownloading && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse shrink-0" />}
        {(model.state === 'available' || needsDownload) && <span className="w-1.5 h-1.5 rounded-full border border-muted-foreground/40 shrink-0" />}
        <span className={`text-[10px] ${
          isSwitching ? 'text-orange-400 font-semibold' :
          isDownloading ? 'text-blue-500 font-semibold' :
          'text-foreground'
        }`}>
          {isSwitching ? 'Switching...' : isDownloading ? 'Downloading...' : model.label}
        </span>
        {needsDownload && (
          <span className="text-[7px] bg-blue-50 text-blue-500 px-1 py-0.5 rounded font-medium">
            download
          </span>
        )}
        {isDownloading && (
          <span className="text-[7px] text-muted-foreground px-1 py-0.5">
            check console for progress
          </span>
        )}
        {model.note && !isBusy && !needsDownload && (
          <span className="text-[7px] bg-primary/10 text-primary px-1 py-0.5 rounded font-medium">
            {model.note}
          </span>
        )}
      </div>
      <span className="w-[44px] text-right text-[9px] text-foreground font-bold">{model.quality}</span>
      <span className="w-[44px] text-right text-[9px] text-foreground font-bold">{model.speed}</span>
      <span className="w-[52px] flex justify-end"><StarRating rating={model.rating} /></span>
    </button>
  );
}

export default function SettingsPanel() {
  const [endpointUrl, setEndpointUrl] = useState('http://192.168.1.10:20300/v1/audio/transcriptions');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<ModelOption[]>(DEFAULT_MODELS);
  const [selectedModelId, setSelectedModelId] = useState('local-fast');
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'testing' | 'connected'>('disconnected');
  const [configLoaded, setConfigLoaded] = useState(false);
  const [gpuInfo, setGpuInfo] = useState<{ available: boolean; adapterName?: string; error?: string } | null>(null);
  const ipcRef = useRef<any>(null);
  // Mirror selectedModelId so fetchModels can reconcile state without
  // becoming stale or triggering re-renders via dependency churn.
  const selectedModelIdRef = useRef(selectedModelId);
  useEffect(() => { selectedModelIdRef.current = selectedModelId; }, [selectedModelId]);

  const reconcileLoadedState = useCallback((list: ModelOption[]): ModelOption[] => {
    const selected = selectedModelIdRef.current;
    return list.map(m => {
      if (m.state === 'switching' || m.state === 'downloading' || m.state === 'download') return m;
      if (m.id === selected) return m.state === 'loaded' ? m : { ...m, state: 'loaded' as ModelState };
      return m.state === 'loaded' ? { ...m, state: 'available' as ModelState } : m;
    });
  }, []);

  const hostedModels = models.filter(m => m.group === 'gpu');
  const localAllModels = models.filter(m => m.group === 'webgpu' || m.group === 'local');
  const isLocalMode = selectedModelId.startsWith('local-') || selectedModelId.startsWith('webgpu-');

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
        .filter(m => GPU_MODEL_MAP[m.id])
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
            note: info.isDefault ? 'recommended' : undefined,
          };
        });

      // Map WebGPU models
      const webgpuFromServer: ModelOption[] = serverModels
        .filter(m => m.group === 'webgpu')
        .map(m => {
          const meta = WEBGPU_MODEL_META[m.id];
          return {
            id: m.id,
            label: meta?.label || m.label || 'English GPU',
            quality: meta?.quality || '98%',
            speed: meta?.speed || '<400ms',
            rating: meta?.rating || 4.5,
            group: 'webgpu' as const,
            state: m.state as ModelState,
            note: 'local',
          };
        });

      // Map local models from server
      const localFromServer: ModelOption[] = serverModels
        .filter(m => m.group === 'local')
        .map(m => {
          const staticMatch = LOCAL_MODELS.find(lm => lm.id === m.id);
          return staticMatch
            ? { ...staticMatch, state: m.state as ModelState }
            : { id: m.id, label: m.label || m.id, quality: '80%', speed: '<2s', rating: 2.5, group: 'local' as const, state: m.state as ModelState };
        });

      const gpuList = gpuFromServer.length > 0 ? gpuFromServer : DEFAULT_MODELS.filter(m => m.group === 'gpu');
      const localList = localFromServer.length > 0 ? localFromServer : LOCAL_MODELS;

      setModels(reconcileLoadedState([...gpuList, ...webgpuFromServer, ...localList]));
    } catch (e) {
      console.error('Failed to fetch models:', e);
    }
  }, [reconcileLoadedState]);

  // Detect WebGPU on mount
  useEffect(() => {
    const detectGpu = async () => {
      const ipc = (window as any).electron?.ipcRenderer;
      if (!ipc) return;
      try {
        const result = await ipc.invoke('webgpu:check-availability');
        setGpuInfo(result);
      } catch {
        setGpuInfo({ available: false, error: 'Detection failed' });
      }
    };
    detectGpu();
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

  // Reconcile model "loaded" state when selectedModelId changes.
  // (fetchModels also reconciles on each fetch — this catches selection
  //  changes that don't trigger a re-fetch.)
  useEffect(() => {
    setModels(prev => {
      const next = reconcileLoadedState(prev);
      return next.some((m, i) => m !== prev[i]) ? next : prev;
    });
  }, [selectedModelId, reconcileLoadedState]);

  // Save config when endpoint/apiKey change
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

      await ipc.invoke('cloud:configure', { endpointUrl, apiKey });
      const result = await ipc.invoke('cloud:test-connection');
      setConnectionStatus(result.success ? 'connected' : 'disconnected');
      if (result.success) await fetchModels();
    } catch (_error) {
      setConnectionStatus('disconnected');
    }
  }, [endpointUrl, apiKey, fetchModels]);

  const handleSelectModel = useCallback(async (model: ModelOption) => {
    if (model.state === 'switching' || model.state === 'downloading') return;

    const previousSelectedId = selectedModelId;
    const isWebGpu = model.group === 'webgpu';

    // WebGPU models: click "download" → show "Downloading..." → stays until model-ready IPC
    // Other models: click → show "Switching..." → completes on engine:switch-model success
    const pendingState: ModelState = isWebGpu ? 'downloading' : 'switching';

    setModels(prev => prev.map(m => ({
      ...m,
      state: m.id === model.id ? pendingState :
             m.id === previousSelectedId ? 'available' as ModelState :
             m.state === 'loaded' ? 'available' as ModelState :
             m.state
    })));

    const ipc = ipcRef.current;

    const completeSwitch = () => {
      setModels(prev => prev.map(m => ({
        ...m,
        state: m.id === model.id ? 'loaded' as ModelState :
               (m.state === 'switching' || m.state === 'downloading') ? 'available' as ModelState :
               m.state === 'loaded' ? 'available' as ModelState :
               m.state
      })));
      setSelectedModelId(model.id);
    };

    if (!ipc) {
      const delay = model.group === 'local' ? 500 : model.group === 'webgpu' ? 5000 : 3000;
      setTimeout(completeSwitch, delay);
      return;
    }

    try {
      const result = await ipc.invoke('engine:switch-model', model.id);
      if (result.success) {
        if (isWebGpu) {
          // WebGPU: switch succeeded but model still downloading in renderer.
          // Set selectedModelId so CaptureApp picks it up and starts the orchestrator.
          setSelectedModelId(model.id);
          ipc.invoke('cloud:configure', { model: model.id }).catch(() => {});

          // Poll until the model is ready (orchestrator loaded in hidden window)
          const pollReady = setInterval(async () => {
            try {
              const status = await ipc.invoke('webgpu:model-status');
              if (status?.downloaded) {
                clearInterval(pollReady);
                completeSwitch();
              }
            } catch { /* keep polling */ }
          }, 2000);
        } else {
          completeSwitch();
          ipc.invoke('cloud:configure', { model: model.id }).catch(() => {});
        }
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
        {/* Endpoint URL -- hidden when local/webgpu model is active */}
        {!isLocalMode && (
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

        {/* API Key -- hidden when local/webgpu model is active */}
        {!isLocalMode && (
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

        {/* Connection Status + Test -- hidden when local/webgpu model is active */}
        {!isLocalMode && (
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

          {/* Hosted */}
          <div className="text-[8px] font-semibold text-muted-foreground uppercase tracking-wider mt-1 mb-0.5 px-1">
            Hosted — Fastest
          </div>
          {/* Column headers */}
          <div className="flex items-center px-2 py-0.5 text-[8px] text-muted-foreground uppercase tracking-wider">
            <span className="flex-1">Model</span>
            <span className="w-[44px] text-right">Quality</span>
            <span className="w-[44px] text-right">Speed</span>
            <span className="w-[52px] text-right">Rating</span>
          </div>

          {hostedModels.map(model => (
            <ModelCard key={model.id} model={model} onSelect={handleSelectModel} />
          ))}

          {/* Divider */}
          <div className="my-1 border-t border-border" />

          {/* Local */}
          <div className="text-[8px] font-semibold text-muted-foreground uppercase tracking-wider mb-0.5 px-1">
            Local — No Internet Required
          </div>
          {gpuInfo && (
            <div className="px-2 mb-0.5">
              {gpuInfo.available ? (
                <span className="text-[8px] text-green-500">
                  WebGPU: Available
                </span>
              ) : (
                <span className="text-[8px] text-muted-foreground">
                  WebGPU: Not available — CPU fallback
                </span>
              )}
            </div>
          )}
          {localAllModels.map(model => (
            <ModelCard key={model.id} model={model} onSelect={handleSelectModel} />
          ))}
        </div>

      </div>
    </div>
  );
}
