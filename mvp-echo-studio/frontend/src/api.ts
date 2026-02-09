import type { TranscriptionResponse, HealthResponse } from "./types";

const BASE = import.meta.env.DEV ? "" : "";

export async function transcribe(
  file: File,
  options: { diarize?: boolean; responseFormat?: string } = {}
): Promise<TranscriptionResponse> {
  const form = new FormData();
  form.append("file", file);
  form.append("response_format", "verbose_json");
  form.append("diarize", String(options.diarize ?? true));

  const res = await fetch(`${BASE}/v1/audio/transcriptions`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }

  return res.json();
}

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch(`${BASE}/health`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
