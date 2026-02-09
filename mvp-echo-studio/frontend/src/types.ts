export interface Segment {
  id: number;
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface TranscriptionResponse {
  text: string;
  segments?: Segment[];
  language?: string;
  duration?: number;
  model?: string;
}

export interface HealthResponse {
  status: string;
  model_loaded: boolean;
  model_id: string;
  cuda_available: boolean;
  gpu_name?: string;
  gpu_memory?: {
    allocated_mb: number;
    reserved_mb: number;
  };
  diarization_available: boolean;
}

export type ExportFormat = "srt" | "vtt" | "txt" | "json";

export type AppState = "idle" | "uploading" | "transcribing" | "done" | "error";
