/**
 * Minimal WebGPU type declarations for gpu-detector.ts.
 * Only covers the subset we actually use.
 */

interface GPUAdapterInfo {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
}

interface GPUSupportedLimits {
  maxBufferSize: number;
  [key: string]: number;
}

interface GPUAdapter {
  readonly limits: GPUSupportedLimits;
  requestAdapterInfo(): Promise<GPUAdapterInfo>;
  requestDevice(): Promise<unknown>;
}

interface GPURequestAdapterOptions {
  powerPreference?: 'low-power' | 'high-performance';
}

interface GPU {
  requestAdapter(options?: GPURequestAdapterOptions): Promise<GPUAdapter | null>;
}

declare global {
  interface Navigator {
    readonly gpu?: GPU;
  }
}

export {};
