import { useState, useEffect, useCallback } from 'react';

export default function SettingsPanel() {
  const [endpointUrl, setEndpointUrl] = useState('http://192.168.1.10:20300/v1/audio/transcriptions');
  const [apiKey, setApiKey] = useState('');
  const [selectedModel, setSelectedModel] = useState('Systran/faster-whisper-base');
  const [selectedLanguage, setSelectedLanguage] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'testing' | 'connected'>('disconnected');
  const [configLoaded, setConfigLoaded] = useState(false);

  // Load config on mount
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const config = await (window as any).electron.ipcRenderer.invoke('cloud:get-config');
        if (config) {
          if (config.endpointUrl) setEndpointUrl(config.endpointUrl);
          if (config.apiKey) setApiKey(config.apiKey);
          if (config.selectedModel) setSelectedModel(config.selectedModel);
          if (config.language) setSelectedLanguage(config.language);
          if (config.isConfigured) setConnectionStatus('connected');
        }
      } catch (e) {
        console.error('Failed to load cloud config:', e);
      } finally {
        setConfigLoaded(true);
      }
    };
    loadConfig();
  }, []);

  // Save config when settings change
  useEffect(() => {
    if (!configLoaded) return;

    (window as any).electron.ipcRenderer.invoke('cloud:configure', {
      endpointUrl,
      apiKey,
      model: selectedModel,
      language: selectedLanguage,
    }).catch((err: Error) => console.warn('Failed to save cloud config:', err));
  }, [configLoaded, endpointUrl, apiKey, selectedModel, selectedLanguage]);

  const handleDebug = useCallback(() => {
    (window as any).electron.ipcRenderer.invoke('debug:open-devtools').catch(() => {});
  }, []);

  const handleTestConnection = useCallback(async () => {
    if (!endpointUrl) return;

    setConnectionStatus('testing');

    try {
      await (window as any).electron.ipcRenderer.invoke('cloud:configure', {
        endpointUrl,
        apiKey,
        model: selectedModel,
        language: selectedLanguage,
      });

      const result = await (window as any).electron.ipcRenderer.invoke('cloud:test-connection');

      if (result.success) {
        setConnectionStatus('connected');
      } else {
        setConnectionStatus('disconnected');
      }
    } catch (_error) {
      setConnectionStatus('disconnected');
    }
  }, [endpointUrl, apiKey, selectedModel, selectedLanguage]);

  return (
    <div className="border-t border-border px-3 py-2 bg-muted/20 max-h-[400px] overflow-y-auto">
      <div className="space-y-2">
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
        <div>
          <label className="text-[9px] font-medium text-muted-foreground block mb-0.5">
            API Key (Optional)
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            className="w-full px-2 py-1 text-[10px] bg-background border border-border rounded"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[9px] font-medium text-muted-foreground block mb-0.5">
              Model
            </label>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="w-full px-1 py-1 text-[10px] bg-background border border-border rounded"
            >
              <option value="Systran/faster-whisper-tiny">tiny (fastest, 39M)</option>
              <option value="Systran/faster-whisper-base">base (balanced, 74M)</option>
              <option value="Systran/faster-whisper-small">small (better, 244M)</option>
              <option value="Systran/faster-whisper-medium">medium (great, 769M)</option>
              <option value="Systran/faster-whisper-large-v2">large-v2 (best, 1.5GB)</option>
              <option value="Systran/faster-whisper-large-v3">large-v3 (latest, 1.5GB)</option>
              <option value="deepdml/faster-whisper-large-v3-turbo-ct2">large-v3-turbo (fast+best) *recommended*</option>
            </select>
          </div>
          <div>
            <label className="text-[9px] font-medium text-muted-foreground block mb-0.5">
              Language
            </label>
            <select
              value={selectedLanguage}
              onChange={(e) => setSelectedLanguage(e.target.value)}
              className="w-full px-1 py-1 text-[10px] bg-background border border-border rounded"
            >
              <option value="">Auto-detect</option>
              <option value="en">English</option>
              <option value="es">Spanish</option>
              <option value="fr">French</option>
              <option value="de">German</option>
              <option value="zh">Chinese</option>
              <option value="ja">Japanese</option>
            </select>
          </div>
        </div>
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
