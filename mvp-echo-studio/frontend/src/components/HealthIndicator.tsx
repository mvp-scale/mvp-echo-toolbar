import { useState, useEffect } from "react";
import { fetchHealth } from "../api";
import type { HealthResponse } from "../types";

export default function HealthIndicator() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;

    async function poll() {
      try {
        const data = await fetchHealth();
        if (alive) {
          setHealth(data);
          setError(false);
        }
      } catch {
        if (alive) setError(true);
      }
    }

    poll();
    const id = setInterval(poll, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (error) {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <div className="w-2 h-2 rounded-full bg-red-500" />
        Offline
      </div>
    );
  }

  if (!health) {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <div className="w-2 h-2 rounded-full bg-gray-500 animate-pulse" />
        Connecting...
      </div>
    );
  }

  const ready = health.model_loaded && health.cuda_available;

  return (
    <div className="flex items-center gap-2 text-xs text-gray-400" title={
      `GPU: ${health.gpu_name || "none"}\n` +
      `Model: ${health.model_id}\n` +
      `VRAM: ${health.gpu_memory ? `${health.gpu_memory.allocated_mb}MB allocated` : "N/A"}\n` +
      `Diarization: ${health.diarization_available ? "yes" : "no"}`
    }>
      <div
        className={`w-2 h-2 rounded-full ${
          ready ? "bg-green-500" : "bg-yellow-500"
        }`}
      />
      <span>
        {health.gpu_name
          ? health.gpu_name.replace("NVIDIA ", "").replace("GeForce ", "")
          : "CPU"}
      </span>
      {health.gpu_memory && (
        <span className="text-gray-600">
          {health.gpu_memory.allocated_mb}MB
        </span>
      )}
    </div>
  );
}
