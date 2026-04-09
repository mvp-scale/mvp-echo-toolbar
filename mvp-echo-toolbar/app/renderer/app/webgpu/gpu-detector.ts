/**
 * GPU Detector -- Checks WebGPU availability in the renderer process.
 *
 * Used by the SettingsPanel to show GPU info and gate the model download option.
 * Also used by the WebGpuBridgeAdapter (via executeJavaScript) for probing.
 */

export interface GpuCapability {
  available: boolean;
  adapterName?: string;
  vendor?: string;
  architecture?: string;
  maxBufferSize?: number;
  estimatedVram?: 'low' | 'medium' | 'high';
  error?: string;
}

/**
 * Detect WebGPU availability and GPU capabilities.
 * Safe to call in any renderer context -- returns a clean result even if WebGPU
 * is entirely unsupported.
 */
export async function detectGpu(): Promise<GpuCapability> {
  if (!navigator.gpu) {
    return { available: false, error: 'WebGPU not supported' };
  }

  try {
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });

    if (!adapter) {
      return { available: false, error: 'No GPU adapter found' };
    }

    const info = await adapter.requestAdapterInfo();
    const maxBuffer = adapter.limits.maxBufferSize;

    return {
      available: true,
      adapterName: info.device || 'Unknown GPU',
      vendor: info.vendor || 'Unknown',
      architecture: info.architecture || '',
      maxBufferSize: maxBuffer,
      estimatedVram: maxBuffer > 2_000_000_000 ? 'high'
        : maxBuffer > 500_000_000 ? 'medium'
        : 'low',
    };
  } catch (err) {
    return {
      available: false,
      error: err instanceof Error ? err.message : 'GPU detection failed',
    };
  }
}
